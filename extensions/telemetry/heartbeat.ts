/**
 * Telemetry heartbeat core (O4, #105) — pure logic, no pi imports.
 *
 * Borrow (MƯỢN) from pi-telemetry 0.1.3 (see learn/landscape-web-access-2026-09-15.md
 * and the observability brief): each pi PROCESS writes one small atomic JSON
 * file at ~/.pi/agent/telemetry/instances/<pid>.json at lifecycle events; any
 * consumer (script, panel, another agent) reads the directory — no daemon, no
 * socket, no long-running collector. A file whose updatedAt is older than
 * PI_TELEMETRY_STALE_MS (default 120s) describes a dead instance; the sweep
 * below deletes such files (and shutdown markers) when the pid is gone.
 *
 * SOC note: files stay on-box, contain no prompt/log content — only counts
 * and pressure levels.
 */

export type Activity = "working" | "waiting_input" | "shutdown" | "unknown";
export type Pressure = "ok" | "near" | "close";

export interface InstancePayload {
	v: 1;
	pid: number;
	sessionId: string | null;
	startedAt: string;
	updatedAt: string;
	activity: Activity;
	turnIndex: number | null;
	/** context pressure snapshot; null right after compaction or if unknown */
	context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	pressure: Pressure;
}

export interface UsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** ≥ NEAR_PCT of the context window → "near"; ≥ CLOSE_PCT → "close". */
export const NEAR_PCT = 85;
export const CLOSE_PCT = 95;

export function classifyPressure(percent: number | null): Pressure {
	if (percent === null) return "ok";
	if (percent >= CLOSE_PCT) return "close";
	if (percent >= NEAR_PCT) return "near";
	return "ok";
}

/** percent override: derive from tokens/window when ctx reports percent null. */
export function effectivePercent(usage: UsageLike | null | undefined): number | null {
	if (!usage) return null;
	if (usage.percent !== null) return usage.percent;
	if (usage.tokens === null || !usage.contextWindow) return null;
	return Math.round((usage.tokens / usage.contextWindow) * 1000) / 10;
}

export interface HeartbeatState {
	pid: number;
	sessionId: string | null;
	startedAt: string;
	turnIndex: number | null;
}

export function buildPayload(
	state: HeartbeatState,
	activity: Activity,
	usage: UsageLike | null | undefined,
	now: Date = new Date(),
): InstancePayload {
	const percent = effectivePercent(usage);
	return {
		v: 1,
		pid: state.pid,
		sessionId: state.sessionId,
		startedAt: state.startedAt,
		updatedAt: now.toISOString(),
		activity,
		turnIndex: state.turnIndex,
		context: usage
			? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
			: null,
		pressure: classifyPressure(percent),
	};
}

/** True when updatedAt is older than staleMs (default 120_000). */
export function isStale(payload: InstancePayload, now: Date = new Date(), staleMs = 120_000): boolean {
	const age = now.getTime() - Date.parse(payload.updatedAt);
	if (!Number.isFinite(age)) return true; // unparseable timestamp == stale
	return age > staleMs;
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// signal 0 = existence probe; throws ESRCH when the pid is gone
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface SweepReport {
	scanned: number;
	deleted: string[];
}

/**
 * Delete instance files that are stale AND (pid dead OR shutdown marker).
 * A stale file with a live pid is left alone: that instance may simply run
 * with telemetry disabled or be suspended. Returns what it did — callers log it.
 */
export function sweepInstances(
	files: Array<{ name: string; payload: InstancePayload | null }>,
	now: Date = new Date(),
	staleMs = 120_000,
): SweepReport {
	const deleted: string[] = [];
	for (const f of files) {
		if (!f.payload) {
			deleted.push(f.name); // unreadable/corrupt JSON: dead weight, remove
			continue;
		}
		if (!isStale(f.payload, now, staleMs)) continue;
		if (f.payload.activity === "shutdown" || !isPidAlive(f.payload.pid)) {
			deleted.push(f.name);
		}
	}
	return { scanned: files.length, deleted };
}
