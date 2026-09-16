/**
 * om_recall (#104, v1.4.91) — read back an observation by its id (timestamp).
 *
 * Borrowed from pi-observational-memory/pom's recall-observation, adapted to
 * this ledger: an observation's id IS its precise timestamp. The tool answers
 * with the ORIGINAL content even after promotion tombstoned it — v1.4.91
 * tombstones carry `recovery` records {timestamp, sha256, span} so the exact
 * content survives even when the original `om.observations.recorded` entry
 * has been folded away by compaction. hash(span) === sha256 must verify the
 * span before we ever present it as the original (never trust unverified
 * recovery data); tokenCount is recomputed with the same estimator that built
 * it (src/tokens.ts — deterministic, never the model's word).
 *
 * Status enum (pom parity, our semantics):
 *  - ok                 exact original returned (recorded entry, or verified tombstone span)
 *  - partial            recovered but inconsistent (recorded original vs tombstone span hash mismatch)
 *  - invalid_id         not a valid observation id format
 *  - not_found          id unknown to every recorded/tombstone entry
 *  - dropped            tombstoned by a pre-v1.4.91 tombstone with no recovery record — content unrecoverable
 *  - no_source          reserved (pom parity): source entry referenced but absent
 *  - source_unavailable a matching om.observations.recorded entry exists but its payload fails validation
 */

import { createHash } from "node:crypto";
import type { Entry, Observation } from "../ledger/types";
import { isObservationsDroppedEntry, isObservationsRecordedEntry } from "../ledger/types";
import { estimateStringTokens } from "../tokens";

export type RecallStatus =
	| "ok"
	| "partial"
	| "invalid_id"
	| "not_found"
	| "no_source"
	| "source_unavailable"
	| "dropped";

export type RecallSource = "recorded" | "tombstone-span";

export interface RecallResult {
	status: RecallStatus;
	id: string;
	/** Present whenever exact original content is returned (ok / partial). */
	observation?: Observation;
	source?: RecallSource;
	/** True when a promotion tombstone covers this id (content may still be ok). */
	tombstoned?: boolean;
	/** Machine-readable explanation for non-ok statuses and edge cases. */
	note?: string;
}

/** sha256 hex of the single-line content — the recovery verification hash. */
export function sha256Content(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Observation ids are precise timestamps "YYYY-MM-DDTHH:MM:SS" with optional ".NN". */
export function isValidObservationId(id: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{2})?$/.test(id);
}

interface TombstoneHit {
	recoverySpan?: { span: string; sha256: string };
}

/**
 * Pure lookup over the WHOLE ledger (pass getEntries(), not a branch —
 * tombstones and re-records can live on other branches after /tree).
 * Newest matching entries win (append order = later entry is truth).
 */
export function recallObservation(allEntries: Entry[], id: string): RecallResult {
	if (!isValidObservationId(id)) {
		return { status: "invalid_id", id, note: `not a valid observation id (expected YYYY-MM-DDTHH:MM:SS[.NN]): ${id}` };
	}

	let recorded: Observation | undefined;
	let recordedBroken = false;
	let tombstone: TombstoneHit | undefined;

	for (const entry of allEntries) {
		if (isObservationsRecordedEntry(entry)) {
			const hit = entry.data.observations.find((o) => o.timestamp === id);
			if (hit) recorded = hit; // last write wins
		} else if (entry.type === "custom" && entry.customType === "om.observations.recorded" && !isObservationsRecordedEntry(entry)) {
			recordedBroken = true; // payload failed validation — cannot trust as source
		} else if (isObservationsDroppedEntry(entry)) {
			if (entry.data.observationTimestamps.includes(id)) {
				const rec = (entry.data.recovery ?? []).find((r) => r.timestamp === id);
				tombstone = rec ? { recoverySpan: { span: rec.span, sha256: rec.sha256 } } : {};
			}
		}
	}

	if (recorded && tombstone?.recoverySpan) {
		const spanHash = sha256Content(tombstone.recoverySpan.span);
		if (spanHash === tombstone.recoverySpan.sha256 && tombstone.recoverySpan.sha256 === sha256Content(recorded.content)) {
			return { status: "ok", id, observation: recorded, source: "recorded", tombstoned: true, note: "promoted to topics (tombstone present); original verified" };
		}
		return {
			status: "partial",
			id,
			observation: recorded,
			source: "recorded",
			tombstoned: true,
			note: "tombstone span does not hash-match the recorded original — content shown is the recorded original; treat tombstone span as suspect",
		};
	}

	if (recorded) {
		return { status: "ok", id, observation: recorded, source: "recorded" };
	}

	if (tombstone?.recoverySpan) {
		const { span, sha256 } = tombstone.recoverySpan;
		if (sha256Content(span) !== sha256) {
			return { status: "dropped", id, tombstoned: true, note: "tombstone recovery span failed sha256 verification — content withheld" };
		}
		// Exact original: span is verbatim, tokenCount recomputed with the same
		// estimator that built the observation (src/ids.ts).
		const observation: Observation = { timestamp: id, content: span, tokenCount: estimateStringTokens(span) };
		return {
			status: "ok",
			id,
			observation,
			source: "tombstone-span",
			tombstoned: true,
			note: "recovered from tombstone span (recorded entry folded away); sha256 verified; tokenCount recomputed",
		};
	}

	if (tombstone) {
		return { status: "dropped", id, tombstoned: true, note: "tombstoned by a pre-v1.4.91 tombstone with no recovery record — original content unrecoverable" };
	}

	if (recordedBroken) {
		return { status: "source_unavailable", id, note: "an om.observations.recorded entry exists but its payload failed validation" };
	}

	return { status: "not_found", id, note: "no recorded observation or tombstone covers this id" };
}
