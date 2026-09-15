import { describe, expect, test } from "bun:test";
import {
	LESSON_TAGS,
	buildLessonLine,
	containsSecret,
	filterByAge,
	formatLesson,
	injectionConfig,
	lessonsFilePath,
	newestN,
	parseLessonsFile,
	parseLessonsLine,
	renderLessonsBlock,
	trimLines,
} from "./lessons-core.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function iso(daysAgo: number): string {
	const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
	return d.toISOString().slice(0, 10);
}

describe("parseLessonsLine / parseLessonsFile", () => {
	test("valid line roundtrips through formatLesson", () => {
		const line = "[2026-09-05][failure] bash silent-abort >2s — use setsid nohup bg";
		const l = parseLessonsLine(line)!;
		expect(l.date).toBe("2026-09-05");
		expect(l.tag).toBe("failure");
		expect(l.text).toContain("setsid nohup");
		expect(formatLesson(l)).toBe(line);
	});

	test("all four tags parse", () => {
		for (const tag of LESSON_TAGS) {
			expect(parseLessonsLine(`[2026-09-01][${tag}] x`)?.tag).toBe(tag);
		}
	});

	test("malformed lines dropped by parseLessonsFile", () => {
		const content = [
			"[2026-09-01][failure] ok one",
			"garbage without format",
			"[2026-09-02][unknown-tag] bad tag",
			"[bad-date][failure] bad date",
			"",
			"[2026-09-03][preference] ok two",
		].join("\n");
		const got = parseLessonsFile(content);
		expect(got.map((l) => l.text)).toEqual(["ok one", "ok two"]);
	});

	test("secret-bearing lines never parse out of a file (defense in depth)", () => {
		const content = [
			"[2026-09-01][failure] leak sk-ant-AAAAAAAAAAAAAAAAAAAAAA in text",
			"[2026-09-01][failure] clean lesson",
		].join("\n");
		const got = parseLessonsFile(content);
		expect(got).toHaveLength(1);
		expect(got[0].text).toBe("clean lesson");
	});
});

describe("containsSecret", () => {
	test("detects common token shapes", () => {
		expect(containsSecret("key sk-ant-0123456789abcdef0123 here")).toBe(true);
		expect(containsSecret("ghp_" + "a".repeat(30))).toBe(true);
		expect(containsSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
		expect(containsSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
	});
	test("clean text passes", () => {
		expect(containsSecret("use nohup for long commands")).toBe(false);
	});
});

describe("buildLessonLine (writer-side guard)", () => {
	test("builds valid line", () => {
		expect(buildLessonLine("2026-09-15", "correction", "old claim superseded by X")).toBe(
			"[2026-09-15][correction] old claim superseded by X",
		);
	});
	test("rejects bad date / unknown tag / empty / multiline / too long", () => {
		expect(buildLessonLine("15-09-2026", "failure", "x")).toBeNull();
		expect(buildLessonLine("2026-09-15", "bogus" as never, "x")).toBeNull();
		expect(buildLessonLine("2026-09-15", "failure", "   ")).toBeNull();
		expect(buildLessonLine("2026-09-15", "failure", "a\nb")).toBeNull();
		expect(buildLessonLine("2026-09-15", "failure", "x".repeat(501))).toBeNull();
	});
	test("rejects secrets before they ever hit disk", () => {
		expect(buildLessonLine("2026-09-15", "failure", "token sk-proj-AAAA1111BBBB2222CCCC")).toBeNull();
	});
});

describe("filterByAge — inclusive boundary", () => {
	test("exactly 30 days passes, 31 drops (default 30)", () => {
		const lessons = [
			{ date: iso(31), tag: "failure" as const, text: "old" },
			{ date: iso(30), tag: "failure" as const, text: "edge" },
		];
		const got = filterByAge(lessons, 30, NOW);
		expect(got.map((l) => l.text)).toEqual(["edge"]);
	});
	test("±1 day around the boundary", () => {
		const mk = (d: number) => ({ date: iso(d), tag: "convention" as const, text: `d${d}` });
		const got = filterByAge([mk(29), mk(30), mk(31)], 30, NOW);
		expect(got.map((l) => l.text)).toEqual(["d29", "d30"]);
	});
	test("future-dated lessons pass (clock skew tolerance)", () => {
		const got = filterByAge([{ date: iso(-1), tag: "failure" as const, text: "future" }], 30, NOW);
		expect(got).toHaveLength(1);
	});
});

describe("newestN — chronological tail", () => {
	test("takes last N in file order (append-only = chronological)", () => {
		const lessons = [1, 2, 3, 4, 5].map((i) => ({
			date: `2026-09-0${i}`,
			tag: "failure" as const,
			text: `L${i}`,
		}));
		expect(newestN(lessons, 3).map((l) => l.text)).toEqual(["L3", "L4", "L5"]);
		expect(newestN(lessons, 8)).toHaveLength(5);
		expect(newestN(lessons, 0)).toHaveLength(0);
	});
});

describe("renderLessonsBlock", () => {
	test("header + one line per lesson", () => {
		const block = renderLessonsBlock([
			{ date: "2026-09-05", tag: "failure", text: "use nohup" },
			{ date: "2026-09-10", tag: "preference", text: "designs before build" },
		]);
		expect(block.split("\n")).toHaveLength(3);
		expect(block).toContain("[2026-09-05][failure] use nohup");
		expect(block).toContain("[2026-09-10][preference] designs before build");
	});
});

describe("trimLines — hysteresis 232→200", () => {
	test("under hysteresis: untouched", () => {
		const lines = Array.from({ length: 232 }, (_, i) => `L${i}`);
		expect(trimLines(lines)).toHaveLength(232);
	});
	test("over hysteresis: batch-drop oldest down to cap", () => {
		const lines = Array.from({ length: 233 }, (_, i) => `L${i}`);
		const got = trimLines(lines);
		expect(got).toHaveLength(200);
		expect(got[0]).toBe("L33"); // oldest 33 dropped
		expect(got[199]).toBe("L232");
	});
});

describe("injectionConfig + lessonsFilePath", () => {
	test("defaults", () => {
		const cfg = injectionConfig({} as never);
		expect(cfg).toEqual({ inject: true, maxLines: 8, maxAgeDays: 30 });
	});
	test("LESSONS_INJECT=0 disables", () => {
		expect(injectionConfig({ LESSONS_INJECT: "0" } as never).inject).toBe(false);
	});
	test("clamps out-of-range values", () => {
		const cfg = injectionConfig({ LESSONS_MAX_LINES: "999", LESSONS_MAX_AGE_DAYS: "x" } as never);
		expect(cfg.maxLines).toBe(50);
		expect(cfg.maxAgeDays).toBe(30);
	});
	test("LESSONS_FILE override + default path", () => {
		expect(lessonsFilePath({ LESSONS_FILE: "/tmp/l.md" }, "/home/coder")).toBe("/tmp/l.md");
		expect(lessonsFilePath({}, "/home/coder")).toBe("/home/coder/.pi/agent/lessons.md");
	});
});
