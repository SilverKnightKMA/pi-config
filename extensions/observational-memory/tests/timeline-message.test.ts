import { describe, expect, it, vi } from "bun:test";
import { makeNullTimelineSink, makeTimelineSink } from "../src/ui/timeline-message.js";

/** Minimal sendMessage recorder standing in for the ExtensionAPI surface the sink uses. */
function recorder() {
	const sent: { customType: string; content: string; display: boolean }[] = [];
	return {
		sent,
		pi: { sendMessage: (m: { customType: string; content: string; display: boolean }, _opts?: unknown) => void sent.push(m) },
	};
}

describe("makeTimelineSink", () => {
	it("emits one custom message per notify call", () => {
		const { sent, pi } = recorder();
		const sink = makeTimelineSink(pi, { coalesce: false });
		sink.notify("observer done");
		expect(sent).toEqual([{ customType: "om-timeline", content: "\n> om: observer done\n", display: true }]);
	});

	it("defers delivery with triggerTurn:false so an active turn is never steered", () => {
		const opts: unknown[] = [];
		const sent: { customType: string; content: string; display: boolean }[] = [];
		const pi = {
			sendMessage: (m: { customType: string; content: string; display: boolean }, o?: unknown) => {
				opts.push(o);
				sent.push(m);
			},
		};
		const sink = makeTimelineSink(pi, { coalesce: false });
		sink.notify("mid-turn line");
		expect(opts).toEqual([{ triggerTurn: false }]);
		expect(sent.length).toBe(1);
	});

	it("coalesces info lines landing in the same tick into one message", () => {
		vi.useFakeTimers();
		const { sent, pi } = recorder();
		const sink = makeTimelineSink(pi);
		sink.notify("observer +3");
		sink.notify("observer +5");
		vi.advanceTimersByTime(1);
		expect(sent.length).toBe(1);
		expect(sent[0].content).toBe("\n> om: observer +3\n> om: observer +5\n");
		vi.useRealTimers();
	});

	it("bypasses the queue for error lines so they are never merged", () => {
		const { sent, pi } = recorder();
		const sink = makeTimelineSink(pi);
		sink.notify("queued line");
		sink.notify("observer failed: boom", "error");
		// Error fired immediately despite a pending queued line.
		expect(sent.length).toBe(1);
		expect(sent[0].content).toBe("\n> om: observer failed: boom\n");
	});

	it("prefixes bare lines but keeps om:-prefixed ones as-is", () => {
		const { sent, pi } = recorder();
		const sink = makeTimelineSink(pi, { coalesce: false });
		sink.notify("plain");
		expect(sent[0].content).toBe("\n> om: plain\n");
	});

	it("survives a sendMessage that throws during teardown", () => {
		const pi = { sendMessage: () => { throw new Error("process closed"); } };
		const sink = makeTimelineSink(pi, { coalesce: false });
		expect(() => sink.notify("anything")).not.toThrow();
	});

	it("flush drains pending lines immediately", () => {
		const { sent, pi } = recorder();
		const sink = makeTimelineSink(pi);
		sink.notify("pending line");
		sink.flush();
		expect(sent.length).toBe(1);
		expect(sent[0].content).toBe("\n> om: pending line\n");
	});

	it("renders worker lifecycle lines with delta", () => {
		const { sent, pi } = recorder();
		const sink = makeTimelineSink(pi, { coalesce: false });
		sink.workerLine({ type: "observer", state: "running" });
		sink.workerLine({ type: "consolidator", state: "done", delta: 7 });
		sink.workerLine({ type: "observer", state: "error" });
		expect(sent.map((m) => m.content)).toEqual([
			"\n> om: observer started\n",
			"\n> om: consolidator done +7\n",
			"\n> om: observer failed\n",
		]);
	});
});

describe("makeNullTimelineSink", () => {
	it("is a silent no-op for every method", () => {
		const sink = makeNullTimelineSink();
		expect(() => {
			sink.notify("x");
			sink.workerLine({ type: "observer", state: "done", delta: 1 });
			sink.flush();
		}).not.toThrow();
	});
});

describe("timeline sink separation (2026-09-01 user request: om events must not glue to agent messages)", () => {
	it("wraps every event batch in a blank-line-fenced blockquote so it renders as its own block", () => {
		const sent: { customType: string; content: string; display: boolean }[] = [];
		const sink = makeTimelineSink({ sendMessage: (m) => sent.push(m) }, { coalesce: false });
		sink.notify("observer done: 16 observations");
		expect(sent[0].customType).toBe("om-timeline");
		expect(sent[0].content).toBe("\n> om: observer done: 16 observations\n");
	});

	it("prefixes each line of a multi-line batch", () => {
		const sent: { content: string }[] = [];
		const sink = makeTimelineSink({ sendMessage: (m) => sent.push(m as never) }, { coalesce: true });
		sink.notify("observer done: 1");
		sink.notify("observer done: 2");
		return new Promise((resolve) => {
			setTimeout(() => {
				expect(sent[0].content).toBe("\n> om: observer done: 1\n> om: observer done: 2\n");
				resolve(null);
			}, 10);
		});
	});
});
