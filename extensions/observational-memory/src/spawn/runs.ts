/**
 * File-based IPC between the in-process orchestrator and subprocess workers.
 *
 * A subprocess cannot append to the master's ledger, so it writes its output to a transient
 * result file under `<project>/.memory/.runs/<runId>.json`. The orchestrator reads + validates
 * it after the process exits, then commits to the right tier (observations → ledger).
 *
 * Worker recordings themselves live in pi's GLOBAL session store, not here (decision 11).
 * `.memory/.runs/` clutter is not GC'd in v1 (accepted).
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the observer model emits, before the orchestrator re-derives precise timestamp-ids. */
export type RawObservation = {
	timestamp: string; // "YYYY-MM-DD HH:MM"
	content: string;
};

export type ObserverRunResult = {
	observations: RawObservation[];
};

export function runsDir(root: string): string {
	return join(root, ".runs");
}

export function runResultPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.result.json`);
}

/**
 * Per-run cost handoff file. Written by the worker EXTENSION (never the model) from pi's
 * built-in `usage.cost.total`, read by the orchestrator after the process exits. Uniform
 * across roles — the consolidator has no observations result file but still reports cost here.
 */
export function runCostPath(root: string, runId: string): string {
	return join(runsDir(root), `${runId}.cost.json`);
}

export type WorkerCostResult = {
	costUsd: number;
	/** Written since 2026-09-05 (pi v1.2.5): role tag so the durable sum can
	 *  split observer/consolidator. Older files carry total-only. */
	role?: "observer" | "consolidator";
};

export function writeWorkerCost(path: string, cost: WorkerCostResult): void {
	atomicWrite(path, JSON.stringify(cost));
}

/** Best-effort read of a worker cost file; returns undefined on missing/malformed input. */
export function readWorkerCost(path: string): WorkerCostResult | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return undefined;
		const cost = (raw as { costUsd?: unknown }).costUsd;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
		const role = (raw as { role?: unknown }).role;
		return {
			costUsd: cost,
			...(role === "observer" || role === "consolidator" ? { role } : {}),
		};
	} catch {
		return undefined;
	}
}

export interface RunCostTotals {
	total: { costUsd: number; runs: number };
	observer: { costUsd: number; runs: number };
	consolidator: { costUsd: number; runs: number };
}

/**
 * Durable session-scoped cost truth: sum every .runs/*.cost.json under the
 * session memory root. The ledger's om.cost entries are a process-lifetime
 * mirror (lost on restart — the session jsonl files never persist them), so
 * this is what survives respawns and keeps "session" meaning "chat session".
 */
export function sumRunCosts(root: string): RunCostTotals {
	const totals: RunCostTotals = {
		total: { costUsd: 0, runs: 0 },
		observer: { costUsd: 0, runs: 0 },
		consolidator: { costUsd: 0, runs: 0 },
	};
	if (!root) return totals;
	let files: string[];
	try {
		files = readdirSync(join(runsDir(root))).filter((f) => f.endsWith(".cost.json"));
	} catch {
		return totals;
	}
	for (const f of files) {
		const cost = readWorkerCost(join(runsDir(root), f));
		if (!cost) continue;
		totals.total.costUsd += cost.costUsd;
		totals.total.runs += 1;
		if (cost.role === "observer") {
			totals.observer.costUsd += cost.costUsd;
			totals.observer.runs += 1;
		} else if (cost.role === "consolidator") {
			totals.consolidator.costUsd += cost.costUsd;
			totals.consolidator.runs += 1;
		}
	}
	return totals;
}

/** Atomic write (temp + rename) so a reader never sees a half-written file. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

function isRawObservation(value: unknown): value is RawObservation {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.timestamp === "string" && typeof v.content === "string" && v.content.trim().length > 0;
}

/** Parse + validate an observer result file. Throws on malformed input. */
export function readObserverResult(path: string): ObserverRunResult {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { observations?: unknown }).observations)) {
		throw new Error("observer result missing observations array");
	}
	const observations = (raw as { observations: unknown[] }).observations.filter(isRawObservation);
	return { observations };
}

export function writeObserverResult(path: string, result: ObserverRunResult): void {
	atomicWrite(path, JSON.stringify(result));
}
