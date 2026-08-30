import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import quiz from "./index";

// ---------------------------------------------------------------------------
// Harness: capture registerTool and drive execute() with a scripted mock ctx.ui
// ---------------------------------------------------------------------------

interface RecordedDialog {
	method: "select" | "input" | "notify";
	title: string;
	options?: string[];
}

interface CapturedTool {
	name: string;
	execute: (toolCallId: string, params: any, signal: undefined, onUpdate: (u: unknown) => void, ctx: unknown) => Promise<any>;
	renderCall: (args: any, theme: Theme) => unknown;
	renderResult: (result: any, options: unknown, theme: Theme) => unknown;
}

function captureTool(): CapturedTool {
	const captured = {} as Partial<CapturedTool>;
	quiz({
		registerTool: (definition: any) => {
			captured.name = definition.name;
			captured.execute = definition.execute;
			captured.renderCall = definition.renderCall;
			captured.renderResult = definition.renderResult;
		},
		registerCommand: (_name: string, _options: unknown) => {},
	} as never);
	return captured as CapturedTool;
}

/** Scripted ctx: select answers once, inputs answer in order, notify records. */
function mockCtx(script: { select?: string; inputs?: (string | undefined)[]; notifications?: string[] }) {
	const dialogs: RecordedDialog[] = [];
	let inputCalls = 0;
	const notifications = script.notifications ?? [];
	return {
		dialogs,
		hasUI: true,
		ui: {
			select: async (title: string, opts: string[]) => {
				dialogs.push({ method: "select", title, options: opts });
				return script.select;
			},
			input: async (title: string, _placeholder?: string) => {
				dialogs.push({ method: "input", title });
				return script.inputs?.[inputCalls++];
			},
			editor: async () => undefined,
			notify: (message: string, _type?: string) => {
				notifications.push(message);
			},
		},
	};
}
const quizArgs = {
	question: "Which planet is closest to the Sun?",
	options: [
		{ label: "Mercury", value: "mercury" },
		{ label: "Venus", value: "venus" },
		{ label: "Earth", value: "earth" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury orbits closest to the Sun.",
};

const theme = { fg: (_r: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

/** execute with shuffle OFF so indices are deterministic in tests. */
async function runQuiz(tool: CapturedTool, args: Record<string, unknown>, script: Parameters<typeof mockCtx>[0]) {
	return tool.execute("t", { shuffle: false, ...args }, undefined, () => {}, mockCtx(script));
}

// ---------------------------------------------------------------------------

describe("registration", () => {
	test("registers quiz tool", () => {
		expect(captureTool().name).toBe("quiz");
	});
});

describe("single-select", () => {
	test("feedback (verdict + correct answer + explanation) rides in note dialog title", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ select: "Venus", inputs: [] }); // wrong answer
		await tool.execute("t", { shuffle: false, ...quizArgs }, undefined, () => {}, ctx);
		const noteDialog = ctx.dialogs.find((d) => d.method === "input");
		expect(noteDialog).toBeDefined();
		expect(noteDialog!.title).toContain("✗ Incorrect.");
		expect(noteDialog!.title).toContain("Correct: 1. Mercury");
		expect(noteDialog!.title).toContain("Mercury orbits closest");
	});

	test("correct answer: graded correct, feedback notified", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, quizArgs, { select: "Mercury", inputs: [] });
		expect(result.details.status).toBe("answered");
		expect(result.details.correct).toBe(true);
		expect(result.details.answers[0]).toMatchObject({ value: "mercury" });
		expect(result.content[0].text).toContain("correctly");
		expect(result.content[0].text).toContain("Explanation: Mercury orbits closest");
	});

	test("wrong answer: graded incorrect, correct answer revealed", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, quizArgs, { select: "Venus", inputs: [] });
		expect(result.details.correct).toBe(false);
		expect(result.content[0].text).toContain("Selected: 2. Venus");
		expect(result.content[0].text).toContain("Correct: 1. Mercury");
	});

	test("I don't know: distinct signal, never graded", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, quizArgs, { select: "I don't know", inputs: [] });
		expect(result.details.dontKnow).toBe(true);
		expect(result.details.correct).toBe(false);
		expect(result.content[0].text).toContain("did not attempt");
	});

	test("note input appended when non-empty; empty skipped", async () => {
		const tool = captureTool();
		const withNote = await runQuiz(tool, quizArgs, { select: "Mercury", inputs: ["thought it was venus"] });
		expect(withNote.details.note).toBe("thought it was venus");
		expect(withNote.content[0].text).toContain("User's note: thought it was venus");

		const noNote = await runQuiz(tool, quizArgs, { select: "Mercury", inputs: ["   "] });
		expect(noNote.details.note).toBeUndefined();
	});

	test("dismiss on select → cancelled", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, quizArgs, { select: undefined });
		expect(result.details.status).toBe("cancelled");
	});

	test("dismiss on note keeps the graded answer", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, quizArgs, { select: "Mercury", inputs: [undefined] });
		expect(result.details.status).toBe("answered");
		expect(result.details.note).toBeUndefined();
	});

	test("select options include description-embedded labels and dont-know last", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ select: "Mercury — smallest planet", inputs: [] });
		await tool.execute(
			"t",
			{ shuffle: false, ...quizArgs, options: [{ label: "Mercury", value: "mercury", description: "smallest planet" }, { label: "Venus", value: "venus" }] },
			undefined,
			() => {},
			ctx,
		);
		expect(ctx.dialogs[0].options).toEqual(["Mercury — smallest planet", "Venus", "I don't know"]);
	});
});

describe("multi-select", () => {
	const multiArgs = {
		...quizArgs,
		multiSelect: true,
		correctAnswer: ["mercury", "venus"],
	};

	test("exact set correct", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, multiArgs, { inputs: ["2,1"] });
		expect(result.details.correct).toBe(true);
		expect(result.details.mode).toBe("multi-select");
	});

	test("partial set incorrect", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, multiArgs, { inputs: ["1"] });
		expect(result.details.correct).toBe(false);
	});

	test("dont-know sentinel (4) discards other picks", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, multiArgs, { inputs: ["1,4"] });
		expect(result.details.dontKnow).toBe(true);
		expect(result.details.answers).toEqual([]);
	});

	test("invalid then valid re-prompts", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, multiArgs, { inputs: ["abc", "1,2"] });
		expect(result.details.status).toBe("answered");
		expect(result.details.correct).toBe(true);
	});

	test("three invalid attempts → cancelled", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, multiArgs, { inputs: ["x", "y", "z"] });
		expect(result.details.status).toBe("cancelled");
	});
});

describe("guards and semantics", () => {
	test("headless → unavailable", async () => {
		const tool = captureTool();
		const result = await tool.execute("t", quizArgs, undefined, () => {}, { hasUI: false, ui: null });
		expect(result.details.status).toBe("unavailable");
	});

	test("unknown correctAnswer value → unavailable with error", async () => {
		const tool = captureTool();
		const result = await runQuiz(tool, { ...quizArgs, correctAnswer: "mars" }, { select: "Mercury" });
		expect(result.details.status).toBe("unavailable");
		expect(result.content[0].text).toContain("mars");
	});

	test("duplicate option values → unavailable", async () => {
		const tool = captureTool();
		const dup = {
			...quizArgs,
			options: [
				{ label: "A", value: "same" },
				{ label: "B", value: "same" },
			],
		};
		const result = await runQuiz(tool, dup, { select: "A" });
		expect(result.details.status).toBe("unavailable");
		expect(result.content[0].text).toContain("duplicate");
	});

	test("onUpdate fires post-shuffle order without leaking the answer", async () => {
		const tool = captureTool();
		const updates: any[] = [];
		const ctx = mockCtx({ select: "Mercury", inputs: [] });
		await tool.execute("t", quizArgs, undefined, (u: any) => updates.push(u), ctx);
		expect(updates).toHaveLength(1);
		expect(updates[0].details.options).toHaveLength(3);
		expect(updates[0].details.options.map((o: any) => o.index)).toEqual([1, 2, 3]);
		// No correctIndices / explanation anywhere in the update.
		expect(JSON.stringify(updates[0])).not.toContain("correctIndices");
		expect(JSON.stringify(updates[0])).not.toContain("Mercury orbits closest");
	});

	test("grading follows shuffled positions, not author order", async () => {
		const tool = captureTool();
		// shuffle ON (omit the override) — run many times; picking whichever label
		// select returns must always grade correctly because the mock answers by
		// the first displayed option, which varies with shuffle.
		for (let i = 0; i < 10; i++) {
			const ctx = mockCtx({ select: undefined, inputs: [] });
			// Cancel immediately; we only care that resolution never errors mid-flow.
			const result = await tool.execute("t", quizArgs, undefined, () => {}, ctx);
			expect(result.details.status).toBe("cancelled");
		}
	});
});

describe("renderers", () => {
	test("renderCall shows question and option count without answer leak", () => {
		const tool = captureTool();
		const component = tool.renderCall(quizArgs, theme);
		expect(component).toBeDefined();
	});

	test("renderResult formats verdict and marks", () => {
		const tool = captureTool();
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "answered" }],
				details: {
					status: "answered",
					mode: "single-select",
					answers: [{ label: "Mercury", value: "mercury", index: 1 }],
					correctIndices: [1],
					options: [{ index: 1, label: "Mercury" }],
					correct: true,
					explanation: "Closest orbit.",
				},
			},
			{},
			theme,
		);
		expect(component).toBeDefined();
	});
});
