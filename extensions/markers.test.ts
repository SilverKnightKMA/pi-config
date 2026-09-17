import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MARKERS.md contract test v2 (producer side).
 * Two invariants:
 *  A. Functional markers ([auto-report], [channel-nack]) still have live emit
 *     sites — they are channel traffic the main agent must see.
 *  B. Display markers (om/zw) must NOT reach the model: the sinks carry an
 *     env-gated escape hatch, but the DEFAULT code path writes state files.
 */

const root = join(import.meta.dir, "..");
const spec = readFileSync(join(root, "MARKERS.md"), "utf8");

const documented = [...spec.matchAll(/Line prefix \(exact\)\s*\|\s*`([^`]+)`/g)].map((m) => m[1]);
expect(documented.length).toBeGreaterThan(0);

const read = (f: string) => readFileSync(join(root, "extensions", f), "utf8");
const omSink = read("observational-memory/src/ui/timeline-message.ts");
const omStatus = read("observational-memory/src/ui/status-file.ts");
const omRuntime = read("observational-memory/src/runtime.ts");
const zw = read("zombie-watchdog/index.ts");
const subIdx = read("subagent-types/index.ts");
const subChan = read("subagent-types/paseo-channel.ts");
const subPool = read("subagent-types/pool.ts");
const taskIdx = read("task/index.ts");
const romIdx = read("read-only-mode/index.ts");
const lessonsCore = read("_shared/lessons-core.ts");
const lessonsIdx = read("lessons/index.ts");

	describe("MARKERS.md producer contract v2", () => {
	test("spec lists all 6 documented prefixes (2 deprecated + 4 active)", () => {
		expect(documented).toContain("> om: ");
		expect(documented).toContain("> zw ⚠ ");
		expect(documented).toContain("[auto-report] ");
		expect(documented).toContain("[channel-nack] ");
		expect(documented).toContain('<machine-notice kind="pool-notice">');
		expect(documented).toContain("Lessons from past sessions");
		expect(spec).toContain("deprecated v2 — history render only");
		expect(spec).toContain("v2.1 change");
	});

	test("B: om sink emits no custom message by default (model-blind)", () => {
		// file branch must run BEFORE the sendMessage branch and carry the env condition
		expect(omSink).toContain('process.env.OM_TIMELINE_EMISSION === "message"');
		expect(omSink.indexOf("appendOmStatusEvent(runtime")).toBeLessThan(omSink.indexOf('customType: "om-timeline"'));
		// runtime is passed into the sink
		expect(omRuntime).toContain("makeTimelineSink(pi, { runtime: this })");
		// status file module exists with a bounded ring
		expect(omStatus).toContain("RING_LIMIT = 24");
		expect(omStatus).toContain("om-status.json");
	});

	test("B: zw emitTimeline off by default, jsonl still written", () => {
		expect(zw).toContain('process.env.ZW_TIMELINE_EMISSION !== "message"');
		expect(zw.indexOf('ZW_TIMELINE_EMISSION')).toBeLessThan(zw.indexOf('customType: "zw-timeline"'));
		expect(zw).toContain("appendDetection");
	});

	test("A: real auto-report prefix at the emit site", () => {
		// v1.4.99 #112: the builder moved to auto-report-join.ts (group-join
		// batching); index.ts keeps the send wiring. Pin BOTH sides.
		const subJoin = read("subagent-types/auto-report-join.ts");
		expect(subJoin).toContain("`[auto-report] Subagent ${who} (${agentId}) finished");
		expect(subJoin).toContain("`[auto-report] ${pings.length} subagents finished");
		expect(subIdx).toContain("flushJoinWindow");
	});

	test("A: real channel-nack prefix with agentId + reason", () => {
		expect(subChan).toContain("`[channel-nack] Kick to subagent ${agentId} FAILED (${errText})");
	});

	test("A: pool-notice envelope at both sendUserMessage sites (#52)", () => {
		expect(subPool).toContain('<machine-notice kind="pool-notice">');
		expect((subIdx.match(/poolNotice\(/g) ?? []).length).toBe(2);
		expect(subIdx).toContain("poolNotice(aggregateReport(state))");
	});

	test("A: wake-prefix family (marker 6, v3 #82) — every prefix at its emit site", () => {
		expect(taskIdx).toContain("`[task wake ${next.rounds}/${TASK_BUDGET}]");
		expect(taskIdx).toContain("[task] continuation wrapped up");
		expect(romIdx).toContain("`[plan wake ${plan.wakeRounds}/${planBudget(nowOpen.length)}]");
		expect(romIdx).toContain("[plan] continuation wrapped up");
		expect(romIdx).toContain("[plan] quiescent");
		// v1.4.86 (#82): wakes are machine-readable custom messages with an
		// escape hatch back to the old user-role text block
		expect(taskIdx).toContain('customType: "task-wake"');
		expect(romIdx).toContain('customType: "plan-wake"');
		expect(taskIdx).toContain('WAKE_CHAT_EMISSION === "1"');
		expect(romIdx).toContain('WAKE_CHAT_EMISSION === "1"');
	});

	test("A: lessons-block header at the emit site, custom-message delivery (marker 7, v3 #110)", () => {
		expect(lessonsCore).toContain('"Lessons from past sessions (global tier, newest last, auto-injected');
		expect(lessonsIdx).toContain('customType: "lessons-context"');
		// the model vaccine stays on: inject at session start + after compaction
		expect(lessonsIdx).toContain("session_start");
		expect(lessonsIdx).toContain("session_compact");
	});

	test("no orphan markers: every documented prefix exists at source (or behind escape hatch)", () => {
		const sources = [omSink, omStatus, omRuntime, zw, subIdx, subChan, subPool, lessonsCore].join("\n");
		for (const pfx of documented) {
			const literal = pfx.split("${")[0].replace(/^> /, "");
			expect(sources.includes(literal)).toBe(true);
		}
	});
});
