import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MARKERS.md contract test (producer side).
 * Every marker documented in /MARKERS.md must literally exist at an emit site
 * in this repo, and every emit-site marker must be documented. A mismatch in
 * either direction fails: silent contract drift is the #1 risk of the
 * text-prefix bridge to the paseo-plugins om-timeline consumer.
 */

const root = join(import.meta.dir, "..");
const spec = readFileSync(join(root, "MARKERS.md"), "utf8");

// documented markers: prefix backticks in the "Line prefix (exact)" rows
const documented = [...spec.matchAll(/Line prefix \(exact\)\s*\|\s*`([^`]+)`/g)].map((m) => m[1]);
expect(documented.length).toBeGreaterThan(0);

const sources = [
	"observational-memory/src/ui/timeline-message.ts",
	"observational-memory/src/hooks/observer-trigger.ts",
	"observational-memory/src/hooks/consolidator-trigger.ts",
	"zombie-watchdog/index.ts",
	"subagent-types/index.ts",
	"subagent-types/paseo-channel.ts",
].map((f) => readFileSync(join(root, "extensions", f), "utf8")).join("\n");

describe("MARKERS.md producer contract", () => {
	test("spec liệt kê đủ 4 marker đã định nghĩa", () => {
		expect(documented).toContain("> om: ");
		expect(documented).toContain("> zw ⚠ ");
		expect(documented).toContain("[auto-report] ");
		expect(documented).toContain("[channel-nack] ");
	});

	test("om prefix thật: PREFIX + blockquote wrap tồn tại ở emit site", () => {
		// timeline-message.ts wraps lines as `> ${l}`; worker lines start "om: "
		expect(sources).toContain("const quoted = lines.map((l) => `> ${l}`).join");
		expect(sources).toContain("`om: observer done: ${observations.length} observations");
		expect(sources).toContain("`om: observer started — summarizing ~${(slice.tokens / 1000).toFixed(1)}k tok");
		expect(sources).toContain("`om: consolidator folding ${promote.length} observations");
	});

	test("zw prefix thật: blockquote wrap + chuỗi cảnh báo B1/B2", () => {
		expect(sources).toContain("`\\n> ${text}\\n`");
		expect(sources).toContain("`zw ⚠ B2: turn đã xong trong process");
		expect(sources).toContain("`zw ⚠ Turn im ${fmtDur(sig.idleMs)}");
	});

	test("auto-report prefix thật", () => {
		expect(sources).toContain("`[auto-report] Subagent ${who} (${agentId}) đã hoàn thành");
	});

	test("channel-nack prefix thật với agentId + lý do", () => {
		expect(sources).toContain("`[channel-nack] Kick tới subagent ${agentId} THẤT BẠI (${errText})");
	});

	test("không marker mồ côi: mọi documented prefix đều tìm thấy ở nguồn", () => {
		for (const pfx of documented) {
			// bỏ phần template động, và bỏ wrap '> ' (blockquote được thêm lúc runtime
			// bởi makeTimelineSink/emitTimeline, không nằm trong chuỗi nguồn)
			const literal = pfx.split("${")[0].replace(/^> /, "");
			expect(sources.includes(literal)).toBe(true);
		}
	});
});
