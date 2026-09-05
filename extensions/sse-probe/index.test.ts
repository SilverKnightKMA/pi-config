import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// classify reads model ids too — "zaicp" lives in the MODEL (cli-openai provider)
import sseProbe, { buildRecord, classify, probePaths, truncate, updateSummary, type ProbeRecord } from "./index";

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

describe("sse-probe event wiring (regression: message_end has NO turnIndex)", () => {
	// 2026-09-05 incident: MessageEndEvent is { type, message } — the old
	// handler deduped on a nonexistent event.turnIndex (-1 === initial -1)
	// and swallowed EVERY drop, including two real zaicp SSE kills.
	const realHome = process.env.PI_HOME;
	let tmpHome: string;

	beforeAll(() => {
		tmpHome = `/tmp/sse-probe-test-${process.pid}`;
		process.env.PI_HOME = tmpHome;
	});
	afterAll(() => {
		if (realHome === undefined) delete process.env.PI_HOME;
		else process.env.PI_HOME = realHome;
	});

	function fakePi() {
		const handlers: Record<string, (event: any, ...rest: any[]) => unknown> = {};
		return {
			on: (ev: string, h: any) => {
				handlers[ev] = h;
			},
			handlers,
		};
	}

	test("message_end without turnIndex still logs, dedupes by message id", () => {
		const { readFileSync, rmSync, existsSync } = require("node:fs") as typeof import("node:fs");
		rmSync(tmpHome, { recursive: true, force: true });
		const pi = fakePi();
		sseProbe(pi as never);
		pi.handlers.session_start?.({}, { sessionManager: { getSessionId: () => "sess-1" } });
		pi.handlers.turn_start?.({ type: "turn_start", turnIndex: 42, timestamp: Date.now() - 5_000 });
		const drop = {
			type: "message_end" as const,
			message: {
				id: "msg-1",
				role: "assistant",
				provider: "cli-openai",
				model: "zaicp/glm-5.3",
				stopReason: "aborted",
				errorMessage: "This operation was aborted",
				content: [{ type: "text", text: "partial answer streamed mid-turn" }],
			},
		};
		pi.handlers.message_end?.(drop);
		pi.handlers.message_end?.(drop); // same message twice -> deduped
		const { jsonl, summary } = probePaths();
		expect(existsSync(jsonl)).toBe(true);
		const lines = readFileSync(jsonl, "utf8").trim().split("\n");
		expect(lines.length).toBe(1);
		const rec = JSON.parse(lines[0]) as ProbeRecord;
		expect(rec.kind).toBe("suspect-sse-drop");
		expect(rec.turnIndex).toBe(42); // captured from turn_start, not the event
		expect(rec.sessionId).toBe("sess-1");
		expect(rec.turnDurMs).toBeGreaterThan(0);
		const s = JSON.parse(readFileSync(summary, "utf8")) as { total: number };
		expect(s.total).toBe(1);
	});
});
