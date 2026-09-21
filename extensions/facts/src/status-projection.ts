/**
 * facts-status projection + un-tombstone control — P4 engine side (#181).
 *
 * Projection: ~/.pi/agent/facts-status.json — the plugin panel's ONLY read
 * surface (pattern om-status/task-status: disk-is-truth, plugin renders, no
 * plugin-side business logic). Refreshed at session_start, after every trigger
 * apply, after every curator run, and on un-tombstone.
 *
 * Control: ~/.pi/agent/facts-control/*.json — the USER-only un-tombstone door
 * (pattern plan-control): the plugin writes {action:"untombstone", id, ts},
 * this watcher applies it (strip tombstoned/reason — the recovery span IS the
 * line) and writes {status:"applied"} back into the same file as the ack.
 * The model has no write path here (memory-guard P1d blocks tool writes).
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { pokeBridges } from "../../_shared/doorbell.ts";
import { registerBellListener } from "../../_shared/doorbell-server.ts";
import { join } from "node:path";
import { isLiveFact, parseFactsFile, serializeFacts, factsFilePath, FACT_CATEGORIES, type FactCategory } from "./store.ts";
import { factsRunsDir, readCuratorState } from "./curator-run.ts";

export function factsStatusPath(env: NodeJS.ProcessEnv = process.env, home = process.env.HOME ?? ""): string {
	return env.FACTS_STATUS_FILE && env.FACTS_STATUS_FILE.trim()
		? env.FACTS_STATUS_FILE
		: join(home, ".pi", "agent", "facts-status.json");
}

export function factsControlDir(env: NodeJS.ProcessEnv = process.env, home = process.env.HOME ?? ""): string {
	return join(home, ".pi", "agent", "facts-control");
}

export interface FactsStatusProjection {
	ts: string;
	file: string;
	live: number;
	tombstoned: number;
	byCategory: Array<{ category: FactCategory; live: number; tombstoned: number }>;
	/** Newest curator receipt summary (null when no run yet). */
	lastCuration: {
		ts: string;
		outcome: string;
		appliedVerdicts: number;
		proposalsAdded: number;
		trigger: string;
	} | null;
	curatorFailing: boolean;
	failingStreak: number;
	lastError: string | null;
	nextThresholds: { minLines: number; minTokens: number; minSessions: number; floorDays: number };
	mtime: string | null;
}

function newestReceipt(runsDir: string): { ts: string; outcome: string; appliedVerdicts: number; proposalsAdded: number; trigger: string } | null {
	try {
		const files = readdirSync(runsDir)
			.filter((f) => f.startsWith("curator-") && f.endsWith(".json"))
			.sort();
		if (!files.length) return null;
		const raw = JSON.parse(readFileSync(join(runsDir, files[files.length - 1]), "utf8"));
		return {
			ts: String(raw.ts ?? ""),
			outcome: String(raw.outcome ?? "?"),
			appliedVerdicts: Number(raw.appliedVerdicts ?? 0),
			proposalsAdded: Number(raw.proposalsAdded ?? 0),
			trigger: String(raw.trigger ?? "?"),
		};
	} catch {
		return null;
	}
}

export function buildFactsStatus(env: NodeJS.ProcessEnv, home: string, thresholds: FactsStatusProjection["nextThresholds"]): FactsStatusProjection | null {
	const file = factsFilePath(env, home);
	let raw: string;
	let mtime: string | null = null;
	try {
		raw = readFileSync(file, "utf8");
		mtime = new Date(statSync(file).mtimeMs).toISOString();
	} catch {
		raw = "";
	}
	const facts = parseFactsFile(raw);
	const byCategory = FACT_CATEGORIES.map((category) => {
		const mine = facts.filter((f) => f.category === category);
		return {
			category,
			live: mine.filter(isLiveFact).length,
			tombstoned: mine.filter((f) => !isLiveFact(f)).length,
		};
	});
	const st = readCuratorState(env, home);
	return {
		ts: new Date().toISOString(),
		file,
		live: facts.filter(isLiveFact).length,
		tombstoned: facts.filter((f) => !isLiveFact(f)).length,
		byCategory,
		lastCuration: newestReceipt(factsRunsDir(env, home)),
		curatorFailing: st.failingStreak >= 2,
		failingStreak: st.failingStreak,
		lastError: st.lastError,
		nextThresholds: thresholds,
		mtime,
	};
}

export function writeFactsStatus(
	env: NodeJS.ProcessEnv = process.env,
	home = process.env.HOME ?? "",
	thresholds: FactsStatusProjection["nextThresholds"] = { minLines: 10, minTokens: 2_000_000, minSessions: 15, floorDays: 30 },
): void {
	const p = buildFactsStatus(env, home, thresholds);
	if (!p) return;
	const target = factsStatusPath(env, home);
	const tmp = `${target}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(p, null, "\t") + "\n");
	renameSync(tmp, target);
	void pokeBridges("facts-status", target, ""); // #39 doorbell — global file, sessionId empty
}

// --- un-tombstone control ------------------------------------------------------

/** Apply one control file. Returns the ack written back into the same file. */
export function applyUntombstone(
	controlFile: string,
	env: NodeJS.ProcessEnv = process.env,
	home = process.env.HOME ?? "",
): { status: string; detail?: string } {
	let req: { action?: string; id?: string };
	try {
		req = JSON.parse(readFileSync(controlFile, "utf8"));
	} catch {
		const ack = { status: "bad-request", detail: "control file is not JSON" };
		writeAck(controlFile, ack);
		return ack;
	}
	if (req.action !== "untombstone" || typeof req.id !== "string") {
		const ack = { status: "bad-request", detail: "expected {action:'untombstone', id}" };
		writeAck(controlFile, ack);
		return ack;
	}
	const file = factsFilePath(env, home);
	try {
		const facts = parseFactsFile(readFileSync(file, "utf8"));
		const target = facts.find((f) => f.id === req.id);
		if (!target) {
			const ack = { status: "not-found", detail: `id ${req.id} not in store` };
			writeAck(controlFile, ack);
			return ack;
		}
		if (!target.tombstoned) {
			const ack = { status: "noop", detail: `id ${req.id} is already live` };
			writeAck(controlFile, ack);
			return ack;
		}
		// strip the tombstone — the recovery span IS the original line
		const next = facts.map((f) => (f.id === req.id ? { ...f, tombstoned: undefined, reason: undefined } : f));
		const tmp = `${file}.untomb-${process.pid}`;
		writeFileSync(tmp, serializeFacts(next) + "\n");
		renameSync(tmp, file);
		const ack = { status: "applied", detail: `id ${req.id} restored` };
		writeAck(controlFile, ack);
		writeFactsStatus(env, home); // panel refreshes on next read
		return ack;
	} catch (e) {
		const ack = { status: "error", detail: String(e).slice(0, 200) };
		writeAck(controlFile, ack);
		return ack;
	}
}

function writeAck(controlFile: string, ack: { status: string; detail?: string }): void {
	try {
		const prev = (() => {
			try {
				return JSON.parse(readFileSync(controlFile, "utf8"));
			} catch {
				return {};
			}
		})();
		writeFileSync(controlFile, JSON.stringify({ ...prev, ...ack, ackAt: new Date().toISOString() }, null, "\t") + "\n");
	} catch {
		/* ack write failure is non-fatal */
	}
}

/** Watch the control dir (pattern plan-control). Debounced; safeOn-style
 *  try/catch — a watcher error must never kill the extension. */
export function watchFactsControl(env: NodeJS.ProcessEnv = process.env, home = process.env.HOME ?? ""): () => void {
	const dir = factsControlDir(env, home);
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		return () => {};
	}
	let timer: ReturnType<typeof setTimeout> | null = null;
	// #39 Phase 2: plugin bell (memory un-tombstone) — instant apply; fs.watch
	// stays as fallback. Rides the shared per-session socket via dispatcher.
	const triggerSweep = (): void => {
		try {
			for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
				const full = join(dir, f);
				let hasAck = false;
				try {
					hasAck = "status" in JSON.parse(readFileSync(full, "utf8"));
				} catch {
					continue; // partial write — next event retries
				}
				if (!hasAck) applyUntombstone(full, env, home);
			}
		} catch {
			/* sweep errors are non-fatal */
		}
	};
	const stopBell = registerBellListener(["facts-control"], () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(triggerSweep, 50);
	});
	try {
		const w = watch(dir, () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(triggerSweep, 200);
		});
		return () => {
			if (timer) clearTimeout(timer);
			stopBell?.();
			try {
				w.close();
			} catch {
				/* already closed */
			}
		};
	} catch {
		return () => {};
	}
}
