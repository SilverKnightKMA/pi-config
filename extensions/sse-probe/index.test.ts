import { describe, expect, test } from "bun:test";
// classify reads model ids too — "zaicp" lives in the MODEL (cli-openai provider)
import { buildRecord, classify, truncate, updateSummary, type ProbeRecord } from "./index";

const base = {
	sessionId: "s1",
	turnIndex: 3,
	provider: "cli-openai",
	model: "zaicp/glm-5.3",
	turnStartedAt: Date.parse("2026-09-05T10:00:00Z"),
	now: Date.parse("2026-09-05T10:00:47Z"),
	lastToolCall: null,
};

describe("sse-probe classify", () => {
	test("zaicp abort with streamed content = suspect-sse-drop", () => {
		expect(
			classify({
				provider: "cli-openai",
				model: "zaicp/glm-5.3",
				stopReason: "error",
				errorMessage: "This operation was aborted",
				contentLen: 512,
			}),
		).toBe("suspect-sse-drop");
	});

	test("abort with no content = abort-no-content (weaker signal)", () => {
		expect(classify({ provider: "zaicp", model: "x", stopReason: "aborted", errorMessage: "This operation was aborted", contentLen: 0 })).toBe("abort-no-content");
	});

	test("abort without errorMessage = user-stop-lookalike", () => {
		expect(classify({ provider: "zaicp", model: "x", stopReason: "aborted", errorMessage: "", contentLen: 40 })).toBe("user-stop-lookalike");
	});

	test("non-abort error = provider-error", () => {
		expect(classify({ provider: "fci", model: "deepseek-v4", stopReason: "error", errorMessage: "HTTP 429", contentLen: 0 })).toBe("provider-error");
	});
});

describe("sse-probe buildRecord", () => {
	test("carries evidence fields + duration", () => {
		const rec = buildRecord({ ...base, stopReason: "error", errorMessage: "This operation was aborted", contentLen: 120 });
		expect(rec.kind).toBe("suspect-sse-drop");
		expect(rec.turnDurMs).toBe(47_000);
		expect(rec.contentLen).toBe(120);
		expect(rec.ts).toBe("2026-09-05T10:00:47.000Z");
		expect(rec.errorMessage).toContain("aborted");
	});

	test("turn_start unseen -> turnDurMs 0", () => {
		const rec = buildRecord({ ...base, turnStartedAt: null, stopReason: "aborted", errorMessage: "x", contentLen: 0 });
		expect(rec.turnDurMs).toBe(0);
	});

	test("long errorMessage truncated to ~200 chars", () => {
		const rec = buildRecord({ ...base, stopReason: "error", errorMessage: "e".repeat(500), contentLen: 0 });
		expect(rec.errorMessage.length).toBeLessThanOrEqual(201);
		expect(rec.errorMessage.endsWith("…")).toBe(true);
	});
});

describe("sse-probe updateSummary", () => {
	const rec: ProbeRecord = {
		ts: "2026-09-05T10:00:47.000Z",
		sessionId: "s1",
		turnIndex: 3,
		provider: "cli-openai",
		model: "zaicp/glm-5.3",
		stopReason: "error",
		kind: "suspect-sse-drop",
		errorMessage: "This operation was aborted",
		turnDurMs: 47000,
		contentLen: 120,
		lastToolCall: null,
	};

	test("from empty: total 1, kind counted, last recorded", () => {
		const s = updateSummary(null, rec, Date.now());
		expect(s.total).toBe(1);
		expect(s.byKind["suspect-sse-drop"]).toBe(1);
		expect(s.last?.ts).toBe(rec.ts);
		expect(s.last24h).toBe(1);
	});

	test("accumulates across updates", () => {
		const s1 = updateSummary(null, rec, Date.now());
		const s2 = updateSummary(s1, { ...rec, kind: "provider-error" }, Date.now());
		expect(s2.total).toBe(2);
		expect(s2.byKind["provider-error"]).toBe(1);
		expect(s2.byKind["suspect-sse-drop"]).toBe(1);
	});

	test("null-shaped prev tolerated", () => {
		const s = updateSummary({ total: 0, byKind: {}, last24h: 0, lastTs: null, last: null }, rec, Date.now());
		expect(s.total).toBe(1);
	});
});

describe("sse-probe truncate", () => {
	test("short strings untouched", () => {
		expect(truncate("short")).toBe("short");
	});
});
