/**
 * #240/#257 (E1, v1.4.135): panel-decision artifact — disk-is-truth,
 * MACHINE-written append-only array at ~/.pi/agent/task-status/<sid>.decisions.json
 *
 * WHO writes: the ENGINE only —
 *   (a) judge hold with amendReason        → kind "amend"
 *   (b) task_update(status:"proposed_cancel") → kind "cancel-proposal"
 *   (c) appeal park (task_update appeal)   → kind "appeal"
 *   (d) task_update {note}                 → kind "note" (display-only, cap 10)
 * The model never writes this file by hand; note/proposed_cancel are AUDITED
 * tool actions, not self-written evidence (that channel was #238 — rejected).
 *
 * WHO decides: the control file ONLY (proposal-decide {dId, decision}) — a
 * user surface (panel button). The model has no deciding verb. Decided
 * entries keep decidedAt+decision (audit trail; 7d TTL prune).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type DecisionKind = "amend" | "cancel-proposal" | "appeal" | "note";
export type DecisionVerdict = "approved" | "rejected";

export interface TaskDecisionEntry {
	id: string; // d-<n>
	taskId: number;
	kind: DecisionKind;
	reason: string;
	createdAt: string;
	decidedAt: string | null;
	decision: DecisionVerdict | null;
}

const KINDS = new Set<DecisionKind>(["amend", "cancel-proposal", "appeal", "note"]);
const NOTE_CAP = 10;
export const DECIDED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure: where the decision artifact for a session lives (HOME rule as taskStatusPath). */
export function decisionsPath(sessionId: string): string {
	const home = process.env.HOME || homedir();
	return join(home, ".pi", "agent", "task-status", `${sessionId}.decisions.json`);
}

function sanitizeEntry(raw: unknown): TaskDecisionEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.id !== "string" || !/^d-\d+$/.test(e.id)) return null;
	if (typeof e.taskId !== "number" || !KINDS.has(e.kind as DecisionKind)) return null;
	return {
		id: e.id,
		taskId: e.taskId,
		kind: e.kind as DecisionKind,
		reason: typeof e.reason === "string" ? e.reason.slice(0, 1000) : "",
		createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
		decidedAt: typeof e.decidedAt === "string" ? e.decidedAt : null,
		decision: e.decision === "approved" || e.decision === "rejected" ? e.decision : null,
	};
}

export function readDecisions(sessionId: string): TaskDecisionEntry[] {
	if (!sessionId) return [];
	let raw: string;
	try {
		raw = readFileSync(decisionsPath(sessionId), "utf8");
	} catch {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map(sanitizeEntry).filter((e): e is TaskDecisionEntry => e !== null);
	} catch {
		return [];
	}
}

function writeAtomic(sessionId: string, list: TaskDecisionEntry[]): void {
	const p = decisionsPath(sessionId);
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
	writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
	renameSync(tmp, p);
}

/** Engine-side append. Note entries keep only the newest NOTE_CAP (display-only). */
export function appendDecision(
	sessionId: string,
	taskId: number,
	kind: DecisionKind,
	reason: string,
	now = Date.now(),
): TaskDecisionEntry {
	const list = readDecisions(sessionId);
	const n = list.reduce((m, e) => Math.max(m, Number(e.id.slice(2)) || 0), 0) + 1;
	const entry: TaskDecisionEntry = {
		id: `d-${n}`,
		taskId,
		kind,
		reason: reason.trim().slice(0, 1000),
		createdAt: new Date(now).toISOString(),
		decidedAt: null,
		decision: null,
	};
	list.push(entry);
	if (kind === "note") {
		const notes = list.filter((e) => e.kind === "note");
		const keep = new Set(notes.slice(-NOTE_CAP).map((e) => e.id));
		const trimmed = list.filter((e) => e.kind !== "note" || keep.has(e.id));
		writeAtomic(sessionId, trimmed);
	} else {
		writeAtomic(sessionId, list);
	}
	return entry;
}

/** User-surface decision (control file only). Returns null when dId unknown/already decided. */
export function decideDecision(sessionId: string, dId: string, decision: DecisionVerdict, now = Date.now()): TaskDecisionEntry | null {
	const list = readDecisions(sessionId);
	const entry = list.find((e) => e.id === dId && e.decidedAt === null);
	if (!entry) return null;
	entry.decidedAt = new Date(now).toISOString();
	entry.decision = decision;
	writeAtomic(sessionId, list);
	return entry;
}

/** 7d TTL housekeeping: drop DECIDED entries older than ttl (undecided + notes stay). */
export function pruneDecided(sessionId: string, ttlMs = DECIDED_TTL_MS, now = Date.now()): boolean {
	const list = readDecisions(sessionId);
	const kept = list.filter((e) => {
		if (!e.decidedAt) return true;
		const at = Date.parse(e.decidedAt);
		return Number.isFinite(at) && now - at <= ttlMs;
	});
	if (kept.length === list.length) return false;
	writeAtomic(sessionId, kept);
	return true;
}
