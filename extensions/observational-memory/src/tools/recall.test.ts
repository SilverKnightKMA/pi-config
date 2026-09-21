import { describe, expect, test } from "bun:test";
import type { Entry, Observation, ObservationsDroppedEntryData } from "../ledger/types";
import { buildObservationsDroppedData, isObservationsDroppedData } from "../ledger/types";
import { isValidObservationId, recallObservation, sha256Content } from "./recall";

// ---------------------------------------------------------------------------
// #104 (v1.4.91) om_recall + sha256 recovery spans — tombstones must keep the
// exact original recoverable; hash verifies before content is ever trusted.
// ---------------------------------------------------------------------------

function obs(timestamp: string, content: string): Observation {
	return { timestamp, content, tokenCount: Math.ceil(content.length / 4) };
}

function recordedEntry(observations: Observation[]): Entry {
	return { type: "custom", id: "re", customType: "om.observations.recorded", data: { observations, coversUpToId: "e1" } };
}

function droppedEntry(data: ObservationsDroppedEntryData): Entry {
	return { type: "custom", id: "de", customType: "om.observations.dropped", data };
}

const O1 = obs("2026-09-16T21:04:13", "user prefers bun over node for test runs");
const O2 = obs("2026-09-16T21:04:13.07", "settled on A+hard-ban lifecycle");

describe("isValidObservationId", () => {
	test("accepts precise timestamps with and without .NN", () => {
		expect(isValidObservationId("2026-09-16T21:04:13")).toBe(true);
		expect(isValidObservationId("2026-09-16T21:04:13.07")).toBe(true);
	});
	test("rejects junk", () => {
		expect(isValidObservationId("deadbeefdead")).toBe(false);
		expect(isValidObservationId("")).toBe(false);
		expect(isValidObservationId("2026-9-16T21:04:13")).toBe(false);
	});
});

describe("recallObservation (#104)", () => {
	test("live recorded observation → ok source=recorded", () => {
		const res = recallObservation([recordedEntry([O1, O2])], "2026-09-16T21:04:13.07");
		expect(res.status).toBe("ok");
		expect(res.source).toBe("recorded");
		expect(res.observation?.content).toBe(O2.content);
		expect(res.tombstoned).toBeUndefined();
	});

	test("recorded + tombstoned with verifying span → ok, tombstoned true", () => {
		const recovery = [{ timestamp: O1.timestamp, sha256: sha256Content(O1.content), span: O1.content }];
		const entries = [recordedEntry([O1]), droppedEntry(buildObservationsDroppedData([O1.timestamp], "e9", recovery)!)];
		const res = recallObservation(entries, O1.timestamp);
		expect(res.status).toBe("ok");
		expect(res.observation?.content).toBe(O1.content);
		expect(res.tombstoned).toBe(true);
		expect(res.note).toContain("promoted");
	});

	test("tombstone span only (recorded entry folded away) → ok source=tombstone-span, tokenCount recomputed", () => {
		const recovery = [{ timestamp: O2.timestamp, sha256: sha256Content(O2.content), span: O2.content }];
		const entries = [droppedEntry(buildObservationsDroppedData([O2.timestamp], "e9", recovery)!)];
		const res = recallObservation(entries, O2.timestamp);
		expect(res.status).toBe("ok");
		expect(res.source).toBe("tombstone-span");
		expect(res.observation?.content).toBe(O2.content);
		expect(res.observation?.tokenCount).toBe(Math.ceil(O2.content.length / 4));
	});

	test("tombstone span hash mismatch vs its own sha256 → dropped, content withheld", () => {
		const recovery = [{ timestamp: O1.timestamp, sha256: "f".repeat(64), span: O1.content }];
		const entries = [droppedEntry(buildObservationsDroppedData([O1.timestamp], "e9", recovery)!)];
		const res = recallObservation(entries, O1.timestamp);
		expect(res.status).toBe("dropped");
		expect(res.observation).toBeUndefined();
		expect(res.note).toContain("sha256 verification");
	});

	test("recorded original vs tombstone span mismatch → partial", () => {
		const forged = "user prefers node over bun (edited span)";
		const recovery = [{ timestamp: O1.timestamp, sha256: sha256Content(forged), span: forged }];
		const entries = [recordedEntry([O1]), droppedEntry(buildObservationsDroppedData([O1.timestamp], "e9", recovery)!)];
		const res = recallObservation(entries, O1.timestamp);
		expect(res.status).toBe("partial");
		expect(res.observation?.content).toBe(O1.content); // recorded original wins
		expect(res.note).toContain("hash-match");
	});

	test("pre-v1.4.91 tombstone (no recovery record) → dropped unrecoverable", () => {
		const entries = [droppedEntry(buildObservationsDroppedData([O1.timestamp], "e9")!)];
		const res = recallObservation(entries, O1.timestamp);
		expect(res.status).toBe("dropped");
		expect(res.note).toContain("pre-v1.4.91");
	});

	test("unknown id → not_found; malformed id → invalid_id", () => {
		const entries = [recordedEntry([O1])];
		expect(recallObservation(entries, "2026-09-16T23:59:59").status).toBe("not_found");
		expect(recallObservation(entries, "junk").status).toBe("invalid_id");
	});

	test("broken recorded payload → source_unavailable", () => {
		const entries: Entry[] = [{ type: "custom", id: "re", customType: "om.observations.recorded", data: { observations: "not-an-array" } }];
		const res = recallObservation(entries, "2026-09-16T21:04:13");
		expect(res.status).toBe("source_unavailable");
	});

	test("later entry wins: re-recorded observation returns the newest content", () => {
		const again = obs(O1.timestamp, "user prefers bun test runner (corrected)");
		const res = recallObservation([recordedEntry([O1]), recordedEntry([again])], O1.timestamp);
		expect(res.status).toBe("ok");
		expect(res.observation?.content).toBe(again.content);
	});
});

describe("tombstone recovery validation (#104)", () => {
	test("isObservationsDroppedData accepts legacy + recovery shapes", () => {
		expect(isObservationsDroppedData({ observationTimestamps: [O1.timestamp], coversUpToId: "e9" })).toBe(true);
		const ok = {
			observationTimestamps: [O1.timestamp],
			coversUpToId: "e9",
			recovery: [{ timestamp: O1.timestamp, sha256: sha256Content(O1.content), span: O1.content }],
		};
		expect(isObservationsDroppedData(ok)).toBe(true);
	});

	test("recovery record outside observationTimestamps or with multi-line span → invalid", () => {
		const bad1 = {
			observationTimestamps: [O1.timestamp],
			coversUpToId: "e9",
			recovery: [{ timestamp: "2026-01-01T00:00:00", sha256: "a".repeat(64), span: "x" }],
		};
		expect(isObservationsDroppedData(bad1)).toBe(false);
		const bad2 = {
			observationTimestamps: [O1.timestamp],
			coversUpToId: "e9",
			recovery: [{ timestamp: O1.timestamp, sha256: "a".repeat(64), span: "two\nlines" }],
		};
		expect(isObservationsDroppedData(bad2)).toBe(false);
	});

	test("buildObservationsDroppedData attaches recovery only when non-empty", () => {
		const rec = [{ timestamp: O1.timestamp, sha256: sha256Content(O1.content), span: O1.content }];
		expect(buildObservationsDroppedData([O1.timestamp], "e9", rec)?.recovery).toHaveLength(1);
		expect(buildObservationsDroppedData([O1.timestamp], "e9", [])?.recovery).toBeUndefined();
	});
});
