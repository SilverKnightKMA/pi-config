import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import quiz from "./index";

// ---------------------------------------------------------------------------
// #103 (v1.4.90): quiz hangs exactly like ask_user_question while unattended —
// same refusal envelope, same temp-dir hermeticity.
// ---------------------------------------------------------------------------

interface CapturedTool {
	name: string;
	execute: (toolCallId: string, params: any, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<any>;
}

function captureTool(): CapturedTool {
	const captured = {} as Partial<CapturedTool>;
	quiz({
		registerTool: (definition: any) => {
			captured.name = definition.name;
			captured.execute = definition.execute;
		},
		registerCommand: (_name: string, _options: unknown) => {
		},
	} as never);
	return captured as CapturedTool;
}

const selectCtx = { hasUI: true, ui: { select: async () => "Mercury", input: async () => "x", notify: () => {} } };

let goalDir = "";
let planDir = "";
let prevBan: string | undefined;

beforeEach(() => {
	goalDir = mkdtempSync(join(tmpdir(), "qban-goal-"));
	planDir = mkdtempSync(join(tmpdir(), "qban-plan-"));
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

describe("quiz refusal (#103)", () => {
	test("running goal → refused with the envelope", async () => {
		writeFileSync(join(goalDir, "s1.json"), JSON.stringify({ status: "running" }));
		const tool = captureTool();
		const params = {
			question: "Which planet is closest to the sun?",
			options: [
				{ label: "Mercury", value: "mercury" },
				{ label: "Venus", value: "venus" },
			],
			correctAnswer: "mercury",
			explanation: "Mercury orbits closest.",
		};
		const res: any = await tool.execute("t1", params, undefined, undefined, selectCtx);
		const text = res.content?.[0]?.text ?? "";
		expect(text).toContain("quiz refused");
		expect(text).toContain("unattended mode (#103)");
	});

	test("tracking plan → refused", async () => {
		writeFileSync(join(planDir, "x.status.json"), JSON.stringify({ mode: "tracking", planId: "p-9", stepsDone: 0, stepsTotal: 4 }));
		const tool = captureTool();
		const params = {
			question: "Q?",
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
			correctAnswer: "a",
			explanation: "A is correct.",
		};
		const res: any = await tool.execute("t2", params, undefined, undefined, selectCtx);
		expect((res.content?.[0]?.text ?? "")).toContain("refused");
	});

	test("INTERACTIVE_BAN=0 → normal flow proceeds", async () => {
		writeFileSync(join(goalDir, "s1.json"), JSON.stringify({ status: "running" }));
		process.env.INTERACTIVE_BAN = "0";
		const tool = captureTool();
		const params = {
			question: "Which planet is closest to the sun?",
			options: [
				{ label: "Mercury", value: "mercury" },
				{ label: "Venus", value: "venus" },
			],
			correctAnswer: "mercury",
			explanation: "Mercury orbits closest.",
		};
		const res: any = await tool.execute("t3", params, undefined, undefined, selectCtx);
		expect((res.content?.[0]?.text ?? "")).toContain("correct");
	});
});
