/**
 * Idle-archive reminder (#129, user-approved 2026-09-20 — LANDSCAPE verdict:
 * BORROW oh-my-opencode's delay anchors, build in-house).
 *
 * Pain: finished subagents accumulate in the agent list (user saw ~50) and
 * nothing ever nudges the parent to archive them. Daemon-side autoArchive is
 * archive-on-terminal — too eager, it kills resume-by-name follow-ups.
 *
 * Design: REMIND, never auto-archive. Fires only when EVERY child of this
 * parent is quiescent (no running/initializing, no parked/attention child)
 * and the NEWEST child has been idle ≥ archiveRemindMinutes (default 15 —
 * between opencode's 10-min cleanup delay and 30-min TTL, and comfortably
 * above our own 12-min SUBAGENT_WAIT_MS blocking window). Archive itself is
 * safe: it is a soft-delete, and sending to an archived child auto-unarchives
 * it (verified live 2026-09-20: archived child woke and answered).
 */
import type { AgentListItem } from "./paseo-channel.ts";

export interface IdleChild {
	id: string;
	status: string | null;
	/** ms epoch of the child's last activity; null = unknown. */
	lastActivityMs: number | null;
	/** ms epoch of an open attention/park marker; null = none. */
	attentionMs: number | null;
}

export interface ArchiveReminder {
	ids: string[];
	command: string;
}

/** Fewer than this many idle children and the list is not crowded enough
 * to be worth a reminder. */
export const MIN_IDLE_CHILDREN = 3;

/** After firing once, stay quiet until a NEW child spawns or this long has
 * passed (re-arm handled by the caller). */
export const ARCHIVE_REMIND_REARM_MS = 60 * 60_000;

// #234 (2026-09-22): engine-side CLI reminder RETIRED — default 0 (off).
// The plugin paseo-subagents v1.0.93 housekeeping is now the single reminder
// source: tool guidance (archive_subagent, runnable by EVERY provider — codex
// and claude parents have no paseo CLI), once per child with a persisted
// reminded.json, plus a 7d force-archive backstop. Keeping this knob for
// rollback only (subagentTypes.archiveRemindMinutes > 0 re-enables).
const DEFAULT_REMIND_MINUTES = 0;

/** settings key: subagentTypes.archiveRemindMinutes — workspace wins over
 * user-wide (same merge order as mainBlockedTools). 0 disables. */
export function readArchiveRemindMinutes(
	wsCfg: Record<string, unknown> | null,
	userCfg: Record<string, unknown> | null,
): number {
	for (const cfg of [wsCfg, userCfg]) {
		if (!cfg) continue;
		const sub = cfg.subagentTypes;
		if (typeof sub !== "object" || sub === null) continue;
		const raw = (sub as Record<string, unknown>).archiveRemindMinutes;
		if (typeof raw === "number" && Number.isFinite(raw)) {
			return Math.min(Math.max(Math.round(raw), 0), 1440);
		}
	}
	return DEFAULT_REMIND_MINUTES;
}

function parseMs(v: unknown): number | null {
	if (typeof v !== "string" || v.length === 0) return null;
	const t = Date.parse(v);
	return Number.isNaN(t) ? null : t;
}

/** Filter an agent list down to MY children (subagent.parent, falling back
 * to the daemon's paseo.parent-agent-id stamp) and project them to IdleChild. */
export function toIdleChildren(agents: AgentListItem[], parentId: string | null): IdleChild[] {
	if (!parentId) return [];
	return agents
		.filter((a) => {
			const p = a.labels?.["subagent.parent"] ?? a.labels?.["paseo.parent-agent-id"];
			return p === parentId;
		})
		.map((a) => ({
			id: a.id,
			status: a.status,
			lastActivityMs: parseMs(a.lastActivityAt ?? a.updatedAt),
			attentionMs: parseMs(a.attentionTimestamp),
		}));
}

/** Pure decision. null = do not remind (fail-closed on every unknown). */
export function shouldRemindIdleArchive(
	children: IdleChild[],
	nowMs: number,
	minutes: number,
): ArchiveReminder | null {
	if (minutes <= 0) return null;
	if (children.length < MIN_IDLE_CHILDREN) return null;
	for (const c of children) {
		if (c.status === "running" || c.status === "initializing") return null; // busy
		if (c.status === "waiting") return null; // parked on a question/decision
		if (c.attentionMs !== null) return null; // open attention marker
		if (c.lastActivityMs === null) return null; // unknown age — never guess
	}
	const newest = Math.max(...children.map((c) => c.lastActivityMs as number));
	if (nowMs - newest < minutes * 60_000) return null; // newest still inside the grace window
	const ids = children.map((c) => c.id);
	return { ids, command: `paseo agent archive ${ids.join(" ")}` };
}
