/**
 * Auto-report join window (#112, BORROW #111 — group-join from
 * @tintinweb/pi-subagents 0.19.0 dist/group-join.js, MIT; rewritten for our
 * parent/child architecture).
 *
 * Upstream runs in ONE process with a RAM Map of registered groups, so it can
 * deliver the instant the last known member completes. Our auto-report fires
 * inside EACH child process — no child can see its siblings. The equivalent
 * that fits disk-is-truth: a per-parent window directory on disk. Children
 * append their pending line; every appender arms the SAME absolute window end
 * (first line's ts + JOIN_MS); whichever timer fires first claims the file
 * (rename — same pattern as drainQueue) and sends ONE combined [auto-report]
 * to main. Latecomers after a flush simply open the next window (upstream's
 * straggler re-batch). Pool children never reach this path (shouldAutoPing
 * poolChild=false → pool aggregate stays the single owner). goal/plan wake
 * active → autoPingOnSettle returns before this module is touched.
 *
 * Trade-off vs upstream: no upfront member set means the window delays even a
 * lone report by JOIN_MS (10s default). This is a background backstop with no
 * latency promise; AUTO_REPORT_JOIN_MS=0 restores the immediate send.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** One child's settled-without-report notice waiting in the window. */
export interface PendingPing {
	agentId: string;
	role: string;
	title?: string;
	/** ISO ts when the child appended — the FIRST line's ts opens the window. */
	ts: string;
}

export const DEFAULT_JOIN_MS = 10_000;

/** Parse AUTO_REPORT_JOIN_MS: default 10s; "0" disables (immediate send);
 *  garbage falls back to the default rather than silently disabling. */
export function joinMsFromEnv(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_JOIN_MS;
	const n = Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_JOIN_MS;
	return Math.max(0, Math.floor(n));
}

export function joinDir(mainAgentId: string, base?: string): string {
	return join(base ?? join(homedir(), ".pi", "agent"), "auto-report-join", mainAgentId);
}

function pendingFile(mainAgentId: string, base?: string): string {
	return join(joinDir(mainAgentId, base), "pending.jsonl");
}

/** Append one pending notice (append-only, crash-safe — same contract as pushToQueue). */
export function appendPending(mainAgentId: string, ping: PendingPing, base?: string): void {
	const dir = joinDir(mainAgentId, base);
	mkdirSync(dir, { recursive: true });
	appendFileSync(pendingFile(mainAgentId, base), JSON.stringify(ping) + "\n", "utf-8");
}

/** Read the current window without claiming it. Torn tail lines are dropped. */
export function readPending(mainAgentId: string, base?: string): PendingPing[] {
	const file = pendingFile(mainAgentId, base);
	if (!existsSync(file)) return [];
	return parseLines(readFileSync(file, "utf-8"));
}

function parseLines(text: string): PendingPing[] {
	const out: PendingPing[] = [];
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			const v = JSON.parse(s) as PendingPing;
			if (v && typeof v.agentId === "string" && typeof v.role === "string" && typeof v.ts === "string") out.push(v);
		} catch {
			// torn tail from a crash — drop
		}
	}
	return out;
}

/**
 * Atomically claim ALL pending notices (rename-based — concurrent claims are
 * safe: the loser finds no file and gets null). Same pattern as drainQueue.
 * Dedupes by agentId keeping the NEWEST line (a child that settled twice
 * after a retry must not double-report inside one batch).
 */
export function claimPending(mainAgentId: string, base?: string): PendingPing[] | null {
	const live = pendingFile(mainAgentId, base);
	if (!existsSync(live)) return null;
	const aside = `${live}.claim-${process.pid}-${Date.now()}`;
	try {
		renameSync(live, aside);
	} catch {
		return null; // a concurrent claimer won the race
	}
	try {
		const byAgent = new Map<string, PendingPing>();
		for (const p of parseLines(readFileSync(aside, "utf-8"))) byAgent.set(p.agentId, p);
		return [...byAgent.values()];
	} finally {
		try {
			unlinkSync(aside);
		} catch {
			// best-effort cleanup; a stale .claim-* file never blocks the next window
		}
	}
}

/** ms to wait before flushing: JOIN_MS after the FIRST pending line's ts.
 *  Empty window or an already-expired one → 0 (flush now / nothing to arm). */
export function windowDelayMs(pending: PendingPing[], joinMs: number, now = Date.now()): number {
	if (pending.length === 0 || joinMs <= 0) return 0;
	const first = pending.reduce((a, b) => (a.ts <= b.ts ? a : b));
	const end = Date.parse(first.ts) + joinMs;
	const d = end - now;
	return d > 0 ? d : 0;
}

/** Single-child batch keeps the EXACT legacy text — zero model-visible change
 *  for the most common case (matches buildAutoPing, re-exported below). */
export function buildAutoPing(role: string, agentId: string, title: string | undefined): string {
	const who = title ? `${role} "${title}"` : role;
	return `[auto-report] Subagent ${who} (${agentId}) finished and went idle without calling message_main. Use paseo_activity(agentId) if you need its result.`;
}

/** N≥2: one combined notice listing every child, with the same pull hint. */
export function buildBatchText(pings: PendingPing[]): string {
	if (pings.length === 1) {
		return buildAutoPing(pings[0].role, pings[0].agentId, pings[0].title);
	}
	const who = pings.map((p) => (p.title ? `${p.role} "${p.title}" (${p.agentId})` : `${p.role} (${p.agentId})`)).join("; ");
	return `[auto-report] ${pings.length} subagents finished and went idle without calling message_main: ${who}. Use paseo_activity(agentId) on any of them if you need a result.`;
}
