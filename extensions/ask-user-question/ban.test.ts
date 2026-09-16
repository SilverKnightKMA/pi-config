import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import askUserQuestion from "./index";
import { unattendedWindow, planWakeActive } from "../_shared/unattended.ts";

// ---------------------------------------------------------------------------
// #103 (v1.4.90) interactive ban — A + lifecycle (user-approved 2026-09-16):
// while a goal is running or a plan session is tracking steps the session is
// unattended; ask_user_question must REFUSE with the #43 envelope instead of
// hanging. Hermetic: every case drives the detector through temp dirs.
// ---------------------------------------------------------------------------

interface CapturedTool {
	name: string;
	execute: (toolCallId: string, params: any, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<any>;
}

function captureTool(): CapturedTool {
	const captured = {} as Partial<CapturedTool>;
	askUserQuestion({
		registerTool: (definition: any) => {
			captured.name = definition.name;
			captured.execute = definition.execute;
		},
		registerCommand: (_name: string, _options: unknown) => {
		},
	} as never);
	return captured as CapturedTool;
}

const selectCtx = { hasUI: true, ui: { select: async () => "Option A", input: async () => "x", editor: async () => "x" } };

let goalDir = "";
let planDir = "";
let prevBan: string | undefined;

beforeEach(() => {
	goalDir = mkdtempSync(join(tmpdir(), "ban-goal-"));
	planDir = mkdtempSync(join(tmpdir(), "ban-plan-"));
	process.env.UNATTENDED_GOAL_DIR = goalDir;
	process.env.UNATTENDED_PLAN_DIR = planDir;
	prevBan = process.env.INTERACTIVE_BAN;
	delete process.env.INTERACTIVE_BAN;
});

afterEach(() => {
	rmSync(goalDir, { recursive: true, force: true });
	rmSync(planDir, { recursive: true, force: true });
	if (prevBan === undefined) delete process.env.INTERACTIVE_BAN;
	else process.env.INTERACTIVE_BAN = prevBan;
});

describe("unattendedWindow (#103)", () => {
	test("running goal → active kind=goal", () => {
		writeFileSync(join(goalDir, "s1.json"), JSON.stringify({ status: "running" }));
		expect(unattendedWindow(goalDir, planDir)).toEqual({ active: true, kind: "goal" });
	});

	test("paused/done goals → inactive", () => {
		writeFileSync(join(goalDir, "s1.json"), JSON.stringify({ status: "paused" }));
		writeFileSync(join(goalDir, "s2.json"), JSON.stringify({ status: "done" }));
		expect(unattendedWindow(goalDir, planDir).active).toBe(false);
	});

	test("tracking plan → active kind=plan", () => {
		writeFileSync(join(planDir, "x.status.json"), JSON.stringify({ mode: "tracking", planId: "p-1", stepsDone: 1, stepsTotal: 3 }));
		expect(unattendedWindow(goalDir, planDir)).toEqual({ active: true, kind: "plan" });
	});

	test("QUIESCENT tracking plan still bans (broader than the wake window)", () => {
		const f = join(planDir, "x.status.json");
		writeFileSync(f, JSON.stringify({ mode: "tracking", planId: "p-1", stepsDone: 1, stepsTotal: 3, quiescent: true }));
		expect(unattendedWindow(goalDir, planDir).active).toBe(true);
		// …while the wake window exempts quiescent plans (#80 single-waker):
		expect(planWakeActive(planDir)).toBe(false);
	});

	test("awaiting plan (user drafting, present) → inactive", () => {
		writeFileSync(join(planDir, "x.status.json"), JSON.stringify({ mode: "awaiting", planId: null }));
		expect(unattendedWindow(goalDir, planDir).active).toBe(false);
	});

	test("INTERACTIVE_BAN=0 disables outright (break-glass)", () => {
		writeFileSync(join(goalDir, "s1.json"), JSON.stringify({ status: "running" }));
		process.env.INTERACTIVE_BAN = "0";
		expect(unattendedWindow(goalDir, planDir).active).toBe(false);
	});
});

describe("ask_user_question refusal (#103)", () => {
	test("running goal → refused with the #43 envelope, no UI call", async () => {
		writeFileSync(join(goalDir, "s1.json"), JSON.stringify({ status: "running" }));
		const tool = captureTool();
		const params = { question: "Pick one", options: [{ label: "Option A", value: "a" }, { label: "Option B", value: "b" }] };
		const res: any = await tool.execute("t1", params, undefined, undefined, selectCtx);
		const text = res.content?.[0]?.text ?? "";
		expect(text).toContain("refused");
		expect(text).toContain("unattended mode (#103)");
		expect(text).toContain("awaitsDecision:true");
		expect(text).toContain("/goal pause");
	});

	test("empty state dirs → normal flow proceeds (no regression)", async () => {
		const tool = captureTool();
		const params = { question: "Pick one", options: [{ label: "Option A", value: "a" }, { label: "Option B", value: "b" }] };
		const res: any = await tool.execute("t2", params, undefined, undefined, selectCtx);
		const text = res.content?.[0]?.text ?? "";
		expect(text).toContain("User selected");
		expect(text).toContain("Option A");
	});
});
