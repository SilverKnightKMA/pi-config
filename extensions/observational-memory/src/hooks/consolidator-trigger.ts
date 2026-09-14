/**
 * Phase B consolidator clock. When the active observation pool crosses
 * `consolidateAtPoolTokens`, promote the oldest observations (above `poolTargetTokens`) into
 * durable `.memory/` topic files via a subprocess consolidator, then tombstone exactly the
 * timestamps it reported back.
 *
 * Runs in the BACKGROUND, mirroring the observer trigger (turn_end / agent_start), strictly
 * one at a time (design risk 4). Compaction does not wait for it (R5).
 *
 * Tombstone safety (design risk 4): the orchestrator tombstones the batch it handed the
 * consolidator, intersected with what is STILL active at exit — never an observation an
 * observer committed during the run (those are not in the handed batch). The consolidator does
 * not report back: it must consolidate everything it was given (filing or discarding junk is a
 * valid outcome), so on clean exit we trust it and drop the whole batch. This guarantees the
 * buffer always drains; a flaked-out partial run is recoverable from the worker's global session
 * recording (the standing safety net for lossy rewrites) and is the critic tier's job to catch.
 *
 * v1.4.56 staging contract: the kickoff shows each topic's heading OUTLINE plus the RECENT TAIL
 * (the newest sections — where dedupe judgment happens), never whole files. The model submits
 * sections / a whole JOURNEY through the engine (see agent/consolidator/{tools,staging}.ts);
 * the engine owns every topic-file write and the JOURNEY budget gate. After each run, topics
 * larger than `TOPIC_COMPACT_THRESHOLD_BYTES` get a dedicated single-file compaction job
 * (append-only files only grow otherwise).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	lastSourceEntryId,
	observationToLine,
	poolTokens,
	selectPromotionOverflow,
	sortObservations,
	sumSessionCost,
	type Entry,
	type Observation,
} from "../ledger/index.js";
import { nowTimestamp } from "../ledger/serialize.js";
import { renderIndexFile } from "../memory/index-render.js";
import { atomicWrite, indexPath, listTopics, readJourney, splitJourneySections } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../spawn/launch.js";
import { recordWorkerCost } from "./observer-trigger.js";
import { readWorkerCost, runCostPath } from "../spawn/runs.js";
import { COMPACT_TOPIC_SYSTEM } from "../../agent/consolidator/prompt.js";

type TriggerCtx = {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => Entry[]; getEntries: () => Entry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};

let runCounter = 0;

function nextRunId(): string {
	runCounter += 1;
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `cons-${stamp}-${process.pid}-${runCounter}`;
}

/** v1.4.56: how much of each topic's tail the kickoff carries verbatim (the newest sections). */
export const TOPIC_TAIL_CHARS = 6_000;
/** v1.4.56: heading outline lines per topic in the kickoff. */
export const TOPIC_OUTLINE_HEADINGS = 60;
/** v1.4.56: append-only bloat valve — files past this size get a single-file compaction job. */
export const TOPIC_COMPACT_THRESHOLD_BYTES = 200_000;

/**
 * Build the consolidator's `-p` kickoff: current time + index + journey (headings + last
 * section) + per-topic outline/tail views + the overflow lines. Topic files are NEVER included
 * whole — the tail is the part the model needs for dedupe/newest-wins judgment, and whole
 * files are what made pre-v1.4.56 runs search (grep/read) for anchors living outside the shown
 * head slice.
 */
export function buildConsolidatorPrompt(
	memoryRoot: string,
	promote: Observation[],
	journeyTargetTokens: number,
): string {
	const topics = listTopics(memoryRoot);
	const indexText = renderIndexFile(topics);
	const journeySections = splitJourneySections(readJourney(memoryRoot) ?? "");
	const journeyHeadings = journeySections
		.filter((s) => s.startsWith("## "))
		.map((s) => s.split("\n")[0])
		.join("\n");
	const journeyLast = journeySections.length ? journeySections[journeySections.length - 1] : undefined;
	const topicViews = topics
		.map((t) => {
			let body = "";
			try {
				body = readFileSync(join(memoryRoot, t.filename), "utf-8");
			} catch {
				body = "(unreadable)";
			}
			const headings = body
				.split("\n")
				.filter((l) => l.startsWith("## "))
				.slice(0, TOPIC_OUTLINE_HEADINGS)
				.join("\n");
			const tail =
				body.length > TOPIC_TAIL_CHARS ? `…(older sections elided)\n${body.slice(-TOPIC_TAIL_CHARS)}` : body;
			return (
				`--- FILE: ${t.filename} (title: ${t.title ?? "-"}; summary: ${t.summary ?? "-"}) ---\n` +
				`HEADING OUTLINE:\n${headings || "(no sections)"}\n` +
				`RECENT TAIL (verbatim — the newest sections, where your submissions land):\n${tail}`
			);
		})
		.join("\n\n");
	const journeyWords = Math.round((journeyTargetTokens * 3) / 4);
	const obsLines = sortObservations(promote).map(observationToLine).join("\n");
	return (
		`Current local time: ${nowTimestamp()}\n\n` +
		"You are folding the observations below into the durable topic files under .memory/. " +
		"You have NO exploration tools — everything you need is in this prompt.\n\n" +
		"===== CURRENT MEMORY INDEX (generated; do not edit INDEX.md) =====\n" +
		`${indexText}\n` +
		"===== END MEMORY INDEX =====\n\n" +
		"===== CURRENT JOURNEY — SECTIONS (headings only; older sections are NOT repeated below) =====\n" +
		`${journeyHeadings || "(no journey yet; start one)"}\n` +
		"===== END JOURNEY SECTIONS =====\n\n" +
		"===== CURRENT JOURNEY — LAST SECTION (verbatim; the only section you must carry forward) =====\n" +
		`${journeyLast ?? "(empty)"}\n` +
		"===== END LAST SECTION =====\n\n" +
		"===== TOPIC FILES — OUTLINE + RECENT TAIL (sections are append-only; newest wins) =====\n" +
		`${topicViews}\n` +
		"===== END TOPIC FILES =====\n\n" +
		"===== OBSERVATIONS TO CONSOLIDATE (each line is `<timestamp-id>  <content>`) =====\n" +
		`${obsLines}\n` +
		"===== END OBSERVATIONS =====\n\n" +
		"ALL INPUTS ARE IN THIS PROMPT. Your tools: submit_sections (one section per topic that changes — " +
		"the engine appends it and maintains front-matter and INDEX) and write_journey (the whole file).\n\n" +
		"1. Fold every observation into sections — state the current truth; skip anything the tails above already cover.\n" +
		"2. REWRITE the whole JOURNEY.md via write_journey: compress the older headings into a few sentences, " +
		`keep the most recent period in the most detail, stay under ~${journeyWords} words ` +
		"(the tool rejects over-budget content — if rejected, compress further and resubmit). " +
		"Purely descriptive, no advice or next steps.\n" +
		"Finish with a one-sentence confirmation."
	);
}

export function evaluateConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime, ctx: TriggerCtx): void {
	if (!runtime.enabled || runtime.config.passive) return;
	if (runtime.consolidatorInFlight) return;

	const branch = ctx.sessionManager.getBranch();
	const active = foldLedger(branch).activeObservations;
	if (poolTokens(active) < runtime.config.consolidateAtPoolTokens) return;

	const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
	if (promote.length === 0) return;

	runtime.consolidatorInFlight = true;
	runtime.timeline.notify(
		`om: consolidator folding ${promote.length} observations (~${(poolTokens(promote) / 1000).toFixed(1)}k tok) into durable topic files…`,
	);
	if (ctx.hasUI) {
		ctx.ui?.notify(`om: consolidator started (${promote.length} obs, ~${poolTokens(promote).toLocaleString()} tok)`, "info");
	}
	// Deliberately NOT tracked in observerTasks: compaction waits only for in-flight observers,
	// never the consolidator (design R5). The consolidatorInFlight flag enforces one-at-a-time.
	void dispatchConsolidator(pi, runtime, ctx, promote);
}

/** v1.4.56 bloat valve: topics past the size threshold (append-only only grows otherwise). */
export function findOversizedTopics(root: string): string[] {
	return listTopics(root)
		.filter((t) => {
			try {
				return statSync(join(root, t.filename)).size > TOPIC_COMPACT_THRESHOLD_BYTES;
			} catch {
				return false;
			}
		})
		.map((t) => t.filename);
}

async function dispatchConsolidator(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
): Promise<void> {
	const runId = nextRunId();
	const controller = new AbortController();
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);

	try {
		const prompt = buildConsolidatorPrompt(runtime.memoryRoot, promote, runtime.config.journeyTargetTokens);
		const argv = buildWorkerArgv({
			model: runtime.config.models.consolidator,
			sessionName: `om-consolidator-${runId}`,
		});
		const env = buildWorkerEnv("consolidator", {
			memoryRoot: runtime.memoryRoot,
			runId,
			journeyTokens: runtime.config.journeyTargetTokens,
		});
		// stdin, not argv: the kickoff can exceed the 128KB MAX_ARG_STRLEN ceiling
		// (live E2BIG incident 2026-09-12).
		const exit = await spawnWorker({ argv, cwd: runtime.memoryRoot, env, stdinData: prompt, signal: controller.signal });
		// Capture cost before the exit-code check so a partial run's spend is still recorded.
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId);
		if (exit.code !== 0) {
			throw new Error(`consolidator exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`);
		}

		// Trust the consolidator: on clean exit it has folded (or discarded) everything we handed it.
		// Re-fold against the CURRENT branch so we never tombstone something already dropped or an
		// observation an observer committed during this run (those are not in the handed batch).
		const branch = ctx.sessionManager.getBranch();
		const stillActive = new Set(foldLedger(branch).activeObservations.map((o) => o.timestamp));
		const toDrop = promote.map((o) => o.timestamp).filter((t) => stillActive.has(t));

		if (toDrop.length > 0) {
			const coversUpToId = lastSourceEntryId(branch);
			if (coversUpToId) {
				pi.appendEntry(OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
			}
		}

		// Re-render INDEX.md so live ls/grep truth leads the pushed map (design risk 3).
		atomicWrite(indexPath(runtime.memoryRoot), renderIndexFile(listTopics(runtime.memoryRoot)));

		runtime.status.workerDone(runId, toDrop.length);
		runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.()?.tokens ?? null);
		const cost = sumSessionCost(ctx.sessionManager.getEntries());
		const runCost = readWorkerCost(runCostPath(runtime.memoryRoot, runId));
		runtime.timeline.notify(
			`om: consolidator done: ${toDrop.length} observations merged into topics · $${(runCost?.costUsd ?? 0).toFixed(4)} this run · session $${cost.costUsd.toFixed(2)} (${cost.runs} runs)`,
		);
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(`om: consolidator done: ${toDrop.length} obs → topics`, "info", ctx.ui.notify.bind(ctx.ui));
		}

		// v1.4.56 bloat valve: still inside consolidatorInFlight (one-at-a-time), compact any
		// topic that crossed the threshold. Best-effort — never fails the consolidation.
		for (const filename of findOversizedTopics(runtime.memoryRoot)) {
			await compactOversizedTopic(pi, runtime, ctx, filename);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		runtime.timeline.notify(`om: consolidator failed: ${message}`, "error");
		if (ctx.hasUI) ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
	} finally {
		runtime.consolidatorController = undefined;
		runtime.consolidatorInFlight = false;
	}
}

/**
 * v1.4.56 valve job: one oversized topic file, verbatim and in full, to the same consolidator
 * model — which sees a single `write_full_file` tool jailed to exactly that file (see
 * agent/consolidator/tools.ts, OM_COMPACT_FILE). Failures are logged, never rethrown.
 */
async function compactOversizedTopic(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	filename: string,
): Promise<void> {
	const runId = `${nextRunId()}-cmp`;
	try {
		let body = "";
		try {
			body = readFileSync(join(runtime.memoryRoot, filename), "utf-8");
		} catch (error) {
			throw new Error(`unreadable topic ${filename}: ${String(error)}`);
		}
		const targetWords = Math.max(200, Math.round(body.length / 60));
		const prompt =
			`Target: rewrite under ~${targetWords} words — at least half the current size, keeping every fact worth keeping.\n\n` +
			`===== FILE: ${filename} (verbatim, full) =====\n${body}\n===== END FILE =====\n`;
		const argv = buildWorkerArgv({
			model: runtime.config.models.consolidator,
			sessionName: `om-compact-${runId}`,
		});
		const env = {
			...buildWorkerEnv("consolidator", { memoryRoot: runtime.memoryRoot, runId }),
			OM_COMPACT_FILE: filename,
		};
		runtime.timeline.notify(`om: compacting oversized topic ${filename} (${Math.round(body.length / 1024)}KB)…`);
		// The valve worker uses the COMPACT_TOPIC_SYSTEM prompt via OM_COMPACT_FILE dispatch
		// (agent/index.ts picks the system prompt when the env is set).
		const exit = await spawnWorker({ argv, cwd: runtime.memoryRoot, env, stdinData: prompt });
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId);
		if (exit.code !== 0) throw new Error(`compaction of ${filename} exited ${exit.code}`);
		runtime.timeline.notify(`om: topic ${filename} compacted`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.timeline.notify(`om: topic compaction failed for ${filename}: ${message}`, "error");
	}
}

export function registerConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => evaluateConsolidatorTrigger(pi, runtime, ctx);
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}
