/**
 * Task status file projection — the read-only mirror of the session task list.
 *
 * Decision (2026-09-08): the session ledger (appendEntry snapshots) stays the
 * single-writer truth for replay; this file is a PROJECTION for post-hoc
 * audit and future Paseo panels (same pattern as om-status.json and
 * zombie-watchdog.jsonl). One file per session under
 * ~/.pi/agent/task-status/<sessionId>.json; written after every commit and
 * after session_start/session_tree replay. Write failures never break tools.
 */
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID as cryptoUuid } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Task, TaskState } from "./types.ts";

export const TASK_STATUS_VERSION = 1;

export interface TaskStatusFile {
	v: number;
	sessionId: string;
	writtenAt: string;
	total: number;
	byStatus: Record<string, number>;
	ready: number[];
	tasks: Array<{
		id: number;
		subject: string;
		description: string;
		status: string;
		evidence: string | null;
		blockedBy: number[];
		blocks: number[];
		updatedAt: number;
		verify?: { lane: string; strict: boolean; probes: number };
		audit?: { verdict: string; summary: string };
		verifyAmendments?: number;
		failStreak?: number;
		judgeRounds?: number;
		appealReason?: string;
	}>;
}

/** Pure: where the projection for a session lives. */
export function taskStatusPath(sessionId: string): string {
	// bun caches os.homedir() after first call, so prefer $HOME explicitly
	// (matches Node's documented os.homedir semantics: $HOME wins when set).
	const home = process.env.HOME || homedir();
	return path.join(home, ".pi", "agent", "task-status", `${sessionId}.json`);
}


/** Pure: build the projection payload from a task state. */
export function buildTaskStatus(state: TaskState, sessionId: string, now = Date.now()): TaskStatusFile {
	const byStatus: Record<string, number> = {};
	for (const task of state.tasks) {
		byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
	}
	const openCount = new Map<number, number>(
		state.tasks.map((task) => [
			task.id,
			task.blockedBy.filter((id) => {
				const blocker = state.tasks.find((t) => t.id === id);
				return blocker ? blocker.status !== "completed" && blocker.status !== "cancelled" : false;
			}).length,
		]),
	);
	return {
		v: TASK_STATUS_VERSION,
		sessionId,
		writtenAt: new Date(now).toISOString(),
		total: state.tasks.length,
		byStatus,
		ready: state.tasks
			.filter((task) => task.status === "pending" && (openCount.get(task.id) ?? 0) === 0)
			.map((task) => task.id),
		tasks: state.tasks.map((task) => ({
			id: task.id,
			subject: task.subject,
			description: task.description,
			status: task.status,
			evidence: task.evidence,
			blockedBy: [...task.blockedBy],
			blocks: [...task.blocks],
			updatedAt: task.updatedAt,
			verify: task.verify
				? { lane: task.verify.lane, strict: task.verify.strict, probes: task.verify.probes.length }
				: undefined,
			audit: task.audit ? { verdict: task.audit.verdict, summary: task.audit.summary } : undefined,
			verifyAmendments: task.verifyAmendments,
			failStreak: task.failStreak,
			judgeRounds: task.judgeRounds,
			appealReason: task.appealReason,
		})),
	};
}

/** Atomic write (tmp + rename) — projection only; failures are the caller's warn.
 * The tmp name must be unique per write: concurrent fire-and-forget writes
 * sharing one tmp name race (A renames while B is mid-write -> ENOENT).
 * Stale tmps for THIS target (process died between writeFile and rename) are
 * swept opportunistically — never other sessions' files. */
export async function writeTaskStatus(filePath: string, summary: TaskStatusFile): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const base = path.basename(filePath);
	try {
		for (const f of await readdir(dir)) {
			if (f.startsWith(`${base}.tmp-`)) await unlink(path.join(dir, f)).catch(() => {});
		}
	} catch {
		// readdir race (dir removed) — sweep is best-effort
	}
	const tmp = `${filePath}.tmp-${process.pid}-${cryptoUuid()}`;
	await writeFile(tmp, JSON.stringify(summary, null, 2) + "\n", "utf8");
	await rename(tmp, filePath);
}
