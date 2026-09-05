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

describe("MARKERS.md producer contract v2", () => {
	test("spec lists all 4 markers (2 deprecated + 2 active)", () => {
		expect(documented).toContain("> om: ");
		expect(documented).toContain("> zw ⚠ ");
		expect(documented).toContain("[auto-report] ");
		expect(documented).toContain("[channel-nack] ");
		expect(spec).toContain("deprecated v2 — history render only");
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
		expect(subIdx).toContain("`[auto-report] Subagent ${who} (${agentId}) finished");
	});

	test("A: real channel-nack prefix with agentId + reason", () => {
		expect(subChan).toContain("`[channel-nack] Kick to subagent ${agentId} FAILED (${errText})");
	});

	test("no orphan markers: every documented prefix exists at source (or behind escape hatch)", () => {
		const sources = [omSink, omStatus, omRuntime, zw, subIdx, subChan].join("\n");
		for (const pfx of documented) {
			const literal = pfx.split("${")[0].replace(/^> /, "");
			expect(sources.includes(literal)).toBe(true);
		}
	});
});
