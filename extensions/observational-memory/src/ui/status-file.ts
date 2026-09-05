/**
 * Workspace-level OM status snapshot for live UI surfaces (Paseo om-status
 * plugin panel). Written by the timeline sink on every OM lifecycle event —
 * v2 (2026-09-04): OM events no longer enter the model context as custom
 * messages; the file is the display channel, the panel polls it.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Runtime } from "../runtime.js";
import { buildStatusLines } from "../commands/status.js";
import { foldLedger } from "../ledger/fold.js";
import { poolTokens } from "../ledger/pool.js";
import { sumSessionCost, type Entry } from "../ledger/types.js";

/**
 * Minimal pi surface the snapshot needs for real numbers. Optional everywhere:
 * unit-test stubs and early wiring pass nothing and fall back to empty views.
 */
export interface PiSnapshotSource {
	sessionManager?: { getBranch?: () => unknown[]; getEntries?: () => unknown[] };
	getContextUsage?: () => { tokens?: number } | undefined | null;
}

function snapshotCtx(pi?: PiSnapshotSource): { branch: Entry[]; allEntries: Entry[]; contextTokens: number | null } {
	let branch: unknown[] = [];
	let all: unknown[] = [];
	let contextTokens: number | null = null;
	try {
		branch = pi?.sessionManager?.getBranch?.() ?? [];
		all = pi?.sessionManager?.getEntries?.() ?? branch;
		contextTokens = pi?.getContextUsage?.()?.tokens ?? null;
	} catch {
		// keep the empty defaults — the file stays display-only, never throws
	}
	return { branch: branch as Entry[], allEntries: all as Entry[], contextTokens };
}

export interface OmStatusEvent {
	ts: string;
	text: string;
}

export interface OmStatusFile {
	schema: 1;
	generatedAt: string;
	enabled: boolean;
	sessionId: string;
	workspace: string;
	/** /om status output lines (same numbers the command shows). */
	lines: string[];
	/** Machine-readable subset for plugin surfaces (pill/cards) — no text parsing. */
	summary?: OmStatusSummary;
	/** Ring of recent lifecycle events, newest last. */
	events: OmStatusEvent[];
}

export interface OmStatusSummary {
	verdict: "working" | "warning" | "healthy";
	observersRunning: number;
	observerSlots: number;
	consolidatorRunning: boolean;
	contextTokens: number | null;
	contextMax: number;
	poolTokens: number;
	poolMax: number;
	sessionCostUsd: number;
	sessionRuns: number;
}

const RING_LIMIT = 24;

export function omStatusPath(runtime: Runtime): string | null {
	if (!runtime.memoryRoot) return null;
	// 2026-09-05 (user report): session-scoped, NOT workspace-level. A workspace
	// can host several concurrent OM sessions (one .memory/<sessionId>/ per
	// chat); a single .memory/om-status.json would be last-writer-wins across
	// them. The Paseo plugin resolves the newest */om-status.json instead.
	return join(runtime.memoryRoot, "om-status.json");
}

async function readRing(path: string): Promise<OmStatusEvent[]> {
	try {
		const prior = JSON.parse(await readFile(path, "utf8")) as { events?: unknown };
		return Array.isArray(prior.events) ? (prior.events as OmStatusEvent[]) : [];
	} catch {
		return [];
	}
}

/**
 * Append a lifecycle event to the ring and rewrite the snapshot. Fire-and-forget safe.
 * `pi` (optional) unlocks real numbers: full-session cost via getEntries() and
 * live context tokens — without it lines degrade to the empty-view defaults.
 */
export async function appendOmStatusEvent(runtime: Runtime, text: string, pi?: PiSnapshotSource): Promise<void> {
	const path = omStatusPath(runtime);
	if (!path) return; // OM off for this session — nothing to show
	try {
		const events = await readRing(path);
		events.push({ ts: new Date().toISOString(), text });
		while (events.length > RING_LIMIT) events.shift();
		await writeSnapshot(runtime, path, events, pi);
	} catch {
		// The status file is display-only: never let a write failure
		// disturb the pipeline. Next event retries.
	}
}

/**
 * Refresh the snapshot WITHOUT appending an event — called on session_start
 * and every turn_end so the panel stays current between OM runs (context
 * grows each turn; workers/pool/cost change only on runs).
 */
export async function writeOmStatusSnapshot(runtime: Runtime, pi?: PiSnapshotSource): Promise<void> {
	const path = omStatusPath(runtime);
	if (!path) return;
	try {
		await writeSnapshot(runtime, path, await readRing(path), pi);
	} catch {
		// same contract as appendOmStatusEvent
	}
}

async function writeSnapshot(runtime: Runtime, path: string, events: OmStatusEvent[], pi?: PiSnapshotSource): Promise<void> {
	const { branch, allEntries, contextTokens } = snapshotCtx(pi);
	const snapshot: OmStatusFile = {
		schema: 1,
		generatedAt: new Date().toISOString(),
		enabled: runtime.enabled,
		sessionId: runtime.memoryRoot ? runtime.memoryRoot.split("/").pop() ?? "" : "",
		workspace: dirname(dirname(runtime.memoryRoot)),
		lines: buildStatusLines(runtime, branch, contextTokens, allEntries),
		summary: buildSummary(runtime, contextTokens, allEntries),
		events,
	};
	const tmp = `${path}.tmp-${process.pid}`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
	await rename(tmp, path);
}

function buildSummary(runtime: Runtime, contextTokens: number | null, allEntries: Entry[]): OmStatusSummary {
	const cfg = runtime.config;
	const running = runtime.observersInFlight.size;
	const { costUsd, runs } = sumSessionCost(allEntries);
	const folded = foldLedger(allEntries);
	const pool = poolTokens(folded.activeObservations);
	const verdict =
		running > 0 || runtime.consolidatorInFlight
			? "working"
			: pool >= cfg.consolidateAtPoolTokens * 0.9 || (contextTokens != null && contextTokens >= cfg.compactAtContextTokens * 0.8)
				? "warning"
				: "healthy";
	return {
		verdict,
		observersRunning: running,
		observerSlots: cfg.observerConcurrency,
		consolidatorRunning: runtime.consolidatorInFlight,
		contextTokens,
		contextMax: cfg.compactAtContextTokens,
		poolTokens: pool,
		poolMax: cfg.consolidateAtPoolTokens,
		sessionCostUsd: costUsd,
		sessionRuns: runs,
	};
}
