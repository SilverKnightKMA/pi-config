/** facts trigger tests — P2 (#179). Pure. */
import { describe, expect, test } from "bun:test";
import { parseFactLine } from "./store.ts";
import { detectCorrection, evaluateTrigger, matchOldFact, tokenize } from "./trigger.ts";

const F = (s: string) => parseFactLine(s)!;
const store = [
	F("[convention][2026-09-01][P1] test runner: bun (#aaa001)"),
	F("[preference][2026-09-02][P2] prefers plain Vietnamese explanations (#aaa002)"),
	F("[ops][2026-09-03][P3] plugin port 34091 (#aaa003)"),
];

describe("detectCorrection PASS 1+2", () => {
	test("VI strong markers fire", () => {
		expect(detectCorrection("thôi từ giờ test bằng npm thay cho bun nhé")?.route).toBe("replace-structure");
		expect(detectCorrection("Đừng dùng bun cho test runner nữa.")?.route).toBe("bare-strong");
		expect(detectCorrection("Đừng dùng bun nữa.")).toBeNull(); // single keyword cannot ground — fail-silent
		expect(detectCorrection("sai rồi, port phải là 40579")?.route).toBe("bare-strong");
	});
	test("EN strong markers fire", () => {
		expect(detectCorrection("actually we use npm now instead of bun")).toBeTruthy();
		expect(detectCorrection("stop using bun for tests")).toBeTruthy();
		expect(detectCorrection("stop using bun")).toBeNull(); // single keyword cannot ground — fail-silent
		expect(detectCorrection("from now on the runner is npm")).toBeTruthy();
	});
	test("plain messages do not fire", () => {
		expect(detectCorrection("làm tiếp việc P3 nhé")).toBeNull();
		expect(detectCorrection("the test suite is green")).toBeNull();
		expect(detectCorrection("")).toBeNull();
	});
	test("negative filter: questions and hedges never fire", () => {
		expect(detectCorrection("thôi từ giờ dùng npm được không?")).toBeNull();
		expect(detectCorrection("hình như em đang dùng bun sai rồi?")).toBeNull();
		expect(detectCorrection("tại sao lại phải từ giờ dùng npm?")).toBeNull();
		expect(detectCorrection("mình thấy có vẻ sai rồi")).toBeNull();
	});
	test("replace-structure extracts old keywords from the replaced part only", () => {
		const d = detectCorrection("thôi từ giờ test bằng npm thay cho bun nhé")!;
		expect(d.oldKeywords).toContain("bun");
		expect(d.oldKeywords).not.toContain("npm");
	});
	test("tokenize strips stopwords + dedupes case-insensitively", () => {
		expect(tokenize("Bun bun và với test")).toEqual(["bun", "test"]);
	});
});

describe("matchOldFact + evaluateTrigger", () => {
	test("replace-structure grounds on the old topic", () => {
		const o = evaluateTrigger("thôi từ giờ test bằng npm thay cho bun nhé", store);
		expect(o.status).toBe("fired-target");
		expect(o.target?.id).toBe("aaa001");
		expect(o.newText).toContain("npm");
	});
	test("bare-strong needs >=2 keyword hits on one live fact", () => {
		const o = evaluateTrigger("Đừng dùng bun cho test runner nữa.", store);
		expect(o.status).toBe("fired-target");
		expect(o.target?.id).toBe("aaa001");
		// single vague word does not ground
		const vague = evaluateTrigger("thôi, port đổi rồi nhé", store);
		expect(vague.status).toBe("fired-no-target");
	});
	test("no store match → fired-no-target (fail-silent, curator catches later)", () => {
		const o = evaluateTrigger("actually we use rust now instead of go", store);
		expect(o.status).toBe("fired-no-target");
	});
	test("tombstoned facts never match", () => {
		const dead = [F("[convention][2026-09-01][P1] use bun (#aaa001) tombstoned=2026-09-10 reason=superseded")];
		expect(evaluateTrigger("stop using bun for tests", dead).status).toBe("fired-no-target");
	});
	test("empty store → fired-no-target", () => {
		expect(evaluateTrigger("thôi dùng npm thay cho bun", []).status).toBe("fired-no-target");
	});
});
