/**
 * Termination ledger (#107 piece A, v1.4.92) — ported concept from
 * @mporenta/pi-claude-code (MIT): every watched turn funnels to EXACTLY ONE
 * terminationReason, idempotently; the per-turn record survives extension
 * reloads, and a reload that finds an unfinalized record stamps it
 * crash-recovered + recovered:true so nothing is ever double-counted or lost.
 *
 * Layout: <dir>/<turnId>.json (one small file per turn), pruned to
 * LEDGER_MAX_AGE_MS at recovery time. Pure fs — no pi imports.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, TerminationReason } from "./watchdog-core.js";

export const LEDGER_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export class TerminationLedger {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private path(turnId: string): string {
		return join(this.dir, `${turnId}.json`);
	}

	open(turnId: string, sessionFile: string | undefined, startedAt: string): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			const record: RunRecord = { turnId, sessionFile, startedAt, detections: [] };
			writeFileSync(this.path(turnId), JSON.stringify(record));
		} catch {
			/* ledger is best-effort — detection must never die on it */
		}
	}

	recordDetection(turnId: string, code: string): void {
		try {
			const r = this.read(turnId);
			if (!r || r.reason) return; // finalized turns are immutable
			r.detections.push(code);
			writeFileSync(this.path(turnId), JSON.stringify(r));
		} catch {
			/* best effort */
		}
	}

	/** Idempotent completion funnel: the FIRST reason wins, later calls no-op
	 *  (returns whether this call was the one that finalized). */
	finalize(turnId: string, reason: TerminationReason, endedAt: string): boolean {
		try {
			const r = this.read(turnId);
			if (!r) return false;
			if (r.reason) return false; // already finalized — funnel is one-shot
			r.reason = reason;
			r.endedAt = endedAt;
			writeFileSync(this.path(turnId), JSON.stringify(r));
			return true;
		} catch {
			return false;
		}
	}

	read(turnId: string): RunRecord | null {
		try {
			const p = this.path(turnId);
			if (!existsSync(p)) return null;
			return JSON.parse(readFileSync(p, "utf8")) as RunRecord;
		} catch {
			return null;
		}
	}

	/** Extension reload recovery: any record with no reason is a turn that was
	 *  being watched when the process died. Stamp crash-recovered (exactly
	 *  once — the rewrite makes it finalized) and prune stale files. */
	recoverStale(now: number, maxAgeMs: number = LEDGER_MAX_AGE_MS): RunRecord[] {
		const recovered: RunRecord[] = [];
		try {
			if (!existsSync(this.dir)) return [];
			for (const f of readdirSync(this.dir)) {
				if (!f.endsWith(".json")) continue;
				const turnId = f.slice(0, -".json".length);
				const r = this.read(turnId);
				if (!r) {
					rmSync(join(this.dir, f), { force: true }); // unparseable junk
					continue;
				}
				if (!r.reason) {
					r.reason = "crash-recovered";
					r.recovered = true;
					r.endedAt = new Date(now).toISOString();
					try {
						writeFileSync(this.path(turnId), JSON.stringify(r));
						recovered.push(r);
					} catch {
						/* keep going */
					}
					continue;
				}
				if (Date.now() - Date.parse(r.startedAt) > maxAgeMs) {
					rmSync(join(this.dir, f), { force: true });
				}
			}
		} catch {
			/* best effort */
		}
		return recovered;
	}
}
