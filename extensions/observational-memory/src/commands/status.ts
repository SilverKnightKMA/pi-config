import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCostByRole, type Entry } from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
import { readCostGcStamp, readRunsRollup, runsCostTtlDays, RESULT_SWEEP_DAYS, sumRunCosts } from "../spawn/runs.js";
import { countWords, journeyWordBudget } from "../../agent/consolidator/staging.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

/**
 * Shared status renderer — the single source of truth for both the /om:status
 * command and the om_status tool. Grouped into sections with a verdict line up
 * front (the one line most reads need), ratios instead of bare numbers, and
 * per-role cost attribution so spend can be traced to observer vs consolidator.
 */
/**
 * Cost for display: the durable truth is `.memory/<sessionId>/.runs/*.cost.json`
 * (workers write them every run); ledger om.cost entries are a process-lifetime
 * mirror that dies on restart, so they only serve as fallback (fresh install,
 * tests) and to keep role split alive for runs whose files predate role tagging.
 * #100: exported so the om-status summary (status-file.ts) reuses the same
 * disk-first, ledger-fallback role split instead of duplicating the logic.
 */
export function costForDisplay(runtime: Runtime, allEntries: Entry[]): {
	total: { costUsd: number; runs: number };
	observer: { costUsd: number; runs: number };
	consolidator: { costUsd: number; runs: number };
} {
	const disk = sumRunCosts(runtime.memoryRoot);
	const ledger = sumSessionCostByRole(allEntries);
	if (disk.total.runs === 0) return ledger;
	return {
		total: disk.total,
		observer: disk.observer.runs > 0 ? disk.observer : ledger.observer,
		consolidator: disk.consolidator.runs > 0 ? disk.consolidator : ledger.consolidator,
	};
}

export function buildStatusLines(
	runtime: Runtime,
	branch: Entry[],
	contextTokens: number | null,
	/** Full-session entries (every branch) for the cost block. Defaults to `branch`. Cost/runs are session-scoped: a freshly-respawned or compacted branch holds none of them, `getEntries()` keeps the true totals. */
	allEntries: Entry[] = branch,
): string[] {
	const cfg = runtime.config;
	const folded = foldLedger(branch);
	const pool = poolTokens(folded.activeObservations);
	const since = rawTokensSinceObservationCoverage(branch);
	const topics = listTopics(runtime.memoryRoot);
	const journey = readJourney(runtime.memoryRoot);
	const cost = costForDisplay(runtime, allEntries);
	// #100: storage/GC surfacing — rollup totals (folded files keep the sums) + TTL
	// config + last sweep day, all read from disk so they survive respawns.
	const rollup = readRunsRollup(runtime.memoryRoot);
	const ttlDays = runsCostTtlDays();
	const gcDay = readCostGcStamp(runtime.memoryRoot);

	const running = runtime.observersInFlight.size;
	const pct = (v: number, max: number) => `${Math.round((v / max) * 100)}%`;
	const k = (t: number) => `${(t / 1000).toFixed(1)}k`;

	const warnings: string[] = [];
	if (runtime.lastWorkerError) warnings.push("last worker error (see bottom)");
	if (pool >= cfg.consolidateAtPoolTokens * 0.9) warnings.push(`pool ${pct(pool, cfg.consolidateAtPoolTokens)} — consolidation imminent`);
	if (contextTokens != null && contextTokens >= cfg.compactAtContextTokens * 0.8)
		warnings.push(`context ${pct(contextTokens, cfg.compactAtContextTokens)} — compaction due soon`);

	const verdict =
		runtime.consolidatorInFlight || running > 0
			? `⏳ working — ${[running > 0 ? `${running}/${cfg.observerConcurrency} observers` : null, runtime.consolidatorInFlight ? "consolidator" : null]
					.filter(Boolean)
					.join(" + ")}`
			: warnings.length > 0
				? `⚠ ${warnings.join("; ")}`
				: "✓ healthy";

	const pendingSlices = Math.ceil(since / cfg.chunkTokens);

	return [
		`om status — ${verdict}`,
		"",
		"Workers",
		`  observers: ${running}/${cfg.observerConcurrency} running · ${pendingSlices} slice(s) of chat waiting to be summarized (~${k(since)} tok)`,
		`  consolidator: ${runtime.consolidatorInFlight ? "running" : "idle"}`,
		"",
		"Buffer",
		`  pool: ${pool.toLocaleString()} tok (${pct(pool, cfg.consolidateAtPoolTokens)} of consolidate-at ${cfg.consolidateAtPoolTokens.toLocaleString()}; drains to ${cfg.poolTargetTokens.toLocaleString()})`,
		`  next slice: ${since.toLocaleString()} / ${cfg.chunkTokens.toLocaleString()} tok`,
		"",
		"Context & files",
		`  context: ${contextTokens != null ? `${contextTokens.toLocaleString()} / ${cfg.compactAtContextTokens.toLocaleString()} tok (${pct(contextTokens, cfg.compactAtContextTokens)})` : "?"}`,
		`  topics (durable): ${topics.length} · journey: ${journey ? `~${Math.round((countWords(journey) * 4) / 3).toLocaleString()} / ${Math.round((journeyWordBudget(cfg.journeyTargetTokens) * 4) / 3).toLocaleString()} tok` : "none yet"}`,
		"",
		"Cost",
		`  session: $${cost.total.costUsd.toFixed(4)} (${cost.total.runs} runs)`,
		`    observer      $${cost.observer.costUsd.toFixed(4)} (${cost.observer.runs} runs)`,
		`    consolidator  $${cost.consolidator.costUsd.toFixed(4)} (${cost.consolidator.runs} runs)`,
		"",

		"Storage & GC",
		`  rollup: ${rollup && rollup.files > 0 ? `${rollup.files} cost file(s) folded · $${rollup.total.costUsd.toFixed(4)} preserved · last ${rollup.rolledUpAt ? rollup.rolledUpAt.slice(0, 10) : "—"}` : "none yet"}`,
		`  cost GC: TTL ${ttlDays}d${ttlDays > 0 ? "" : " (off)"} · last sweep ${gcDay || "never"} · result sweep ${RESULT_SWEEP_DAYS}d`,
		`  last error: ${runtime.lastWorkerError ?? "none"}`,
	];
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational-memory status (verdict, workers, buffer, files, cost)",
		handler: async (_args: string, ctx: any) => {
			if (!runtime.enabled) {
				runtime.timeline.notify("om is off (use /om on to enable)");
				if (ctx.hasUI) ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const lines = [
				...buildStatusLines(
				runtime,
				branch,
					ctx.getContextUsage?.()?.tokens ?? null,
					(ctx.sessionManager.getEntries?.() as Entry[] | undefined) ?? branch,
				),
				"",
				renderTimeline(branch, runtime.config),
			];
			// Paseo timeline first (survives mid-turn); TUI keeps its notify popup.
			runtime.timeline.notify(lines.join("\n"));
			ctx.ui?.notify(lines.join("\n"), "info");
		},
	});
}
