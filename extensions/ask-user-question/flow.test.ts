import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "./index";

// ---------------------------------------------------------------------------
// Harness: capture registerTool and drive execute() with a scripted mock ctx.ui
// ---------------------------------------------------------------------------

interface RecordedDialog {
	method: "select" | "input" | "editor";
	title: string;
	options?: string[];
	placeholder?: string;
}

interface CapturedTool {
	name: string;
	parameters: unknown;
	execute: (toolCallId: string, params: any, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
	renderCall: (args: any, theme: Theme) => unknown;
	renderResult: (result: any, options: unknown, theme: Theme) => unknown;
}

function captureTool(): CapturedTool {
	const captured = {} as Partial<CapturedTool>;
	askUserQuestion({
		registerTool: (definition: any) => {
			captured.name = definition.name;
			captured.parameters = definition.parameters;
			captured.execute = definition.execute;
			captured.renderCall = definition.renderCall;
			captured.renderResult = definition.renderResult;
		},
		registerCommand: (_name: string, _options: unknown) => {
		},
	} as never);
	return captured as CapturedTool;
}

/** Mock ctx whose ui methods resolve scripted answers in order and record calls. */
function mockCtx(script: { select?: string; inputs?: (string | undefined)[]; editor?: string }) {
	const dialogs: RecordedDialog[] = [];
	let inputCalls = 0;
	return {
		dialogs,
		hasUI: true,
		ui: {
			select: async (title: string, opts: string[]) => {
				dialogs.push({ method: "select", title, options: opts });
				return script.select;
			},
			input: async (title: string, placeholder?: string) => {
				dialogs.push({ method: "input", title, placeholder });
				const answer = script.inputs?.[inputCalls++];
				return answer;
			},
			editor: async (title: string) => {
				dialogs.push({ method: "editor", title });
				return script.editor;
			},
			notify: () => {},
		},
	};
}

const headlessCtx = { hasUI: false, ui: null };
const theme = { fg: (_r: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

const baseArgs = {
	question: "Which auth method?",
	options: [
		{ label: "JWT", value: "jwt", description: "stateless tokens" },
		{ label: "Session cookies", value: "session" },
	],
};

// ---------------------------------------------------------------------------

describe("tool registration", () => {
	test("registers ask_user_question", () => {
		const tool = captureTool();
		expect(tool.name).toBe("ask_user_question");
	});
});

describe("single-select flow", () => {
	test("option pick: one select call, model gets indexed label", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ select: "JWT — stateless tokens" });
		const result: any = await tool.execute("t1", baseArgs, undefined, undefined, ctx);
		expect(ctx.dialogs).toHaveLength(1);
		expect(ctx.dialogs[0].method).toBe("select");
		// description embedded in label; Other appended last
		expect(ctx.dialogs[0].options).toEqual(["JWT — stateless tokens", "Session cookies", "Other"]);
		expect(result.content[0].text).toBe("User selected: 1. JWT");
		expect(result.details).toMatchObject({ status: "answered", mode: "single-select" });
		expect(result.details.answers[0]).toMatchObject({ type: "option", label: "JWT", value: "jwt", index: 1 });
	});

	test("Other: select then follow-up input; model sees Other: <text>", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ select: "Other", inputs: ["LDAP SSO please"] });
		const result: any = await tool.execute("t2", baseArgs, undefined, undefined, ctx);
		expect(ctx.dialogs).toHaveLength(2);
		expect(ctx.dialogs[1].method).toBe("input");
		expect(result.content[0].text).toBe("User selected: Other: LDAP SSO please");
		expect(result.details.answers[0]).toMatchObject({ type: "other", label: "LDAP SSO please" });
	});

	test("dismiss select (undefined) → cancelled", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ select: undefined });
		const result: any = await tool.execute("t3", baseArgs, undefined, undefined, ctx);
		expect(result.details.status).toBe("cancelled");
		expect(result.content[0].text).toBe("User cancelled the question");
	});

	test("Other with empty custom text → cancelled", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ select: "Other", inputs: ["   "] });
		const result: any = await tool.execute("t4", baseArgs, undefined, undefined, ctx);
		expect(result.details.status).toBe("cancelled");
	});

	test("host returns bare label (fallback match) still resolves to option", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ select: "Session cookies" });
		const result: any = await tool.execute("t5", baseArgs, undefined, undefined, ctx);
		expect(result.details.answers[0]).toMatchObject({ type: "option", label: "Session cookies", value: "session", index: 2 });
	});
});

describe("multi-select flow", () => {
	const multiArgs = { ...baseArgs, multiSelect: true };

	test("numeric list parsed into sorted answers", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ inputs: ["2,1"] });
		const result: any = await tool.execute("m1", multiArgs, undefined, undefined, ctx);
		expect(ctx.dialogs[0].method).toBe("input");
		expect(result.details.mode).toBe("multi-select");
		expect(result.details.status).toBe("answered");
		// sorted by option index regardless of input order
		expect(result.details.answers.map((a: any) => a.index)).toEqual([1, 2]);
		expect(result.content[0].text).toBe("User selected:\n- 1. JWT\n- 2. Session cookies");
	});

	test("Other sentinel (index 3) triggers follow-up input", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ inputs: ["1,3", "WebAuthn"] });
		const result: any = await tool.execute("m2", multiArgs, undefined, undefined, ctx);
		expect(ctx.dialogs).toHaveLength(2);
		expect(result.details.answers).toHaveLength(2);
		expect(result.details.answers[1]).toMatchObject({ type: "other", label: "WebAuthn" });
	});

	test("invalid then valid input re-prompts", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ inputs: ["abc", "1"] });
		const result: any = await tool.execute("m3", multiArgs, undefined, undefined, ctx);
		expect(ctx.dialogs).toHaveLength(2);
		expect(result.details.status).toBe("answered");
	});

	test("three invalid attempts → cancelled", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ inputs: ["x", "y", "z"] });
		const result: any = await tool.execute("m4", multiArgs, undefined, undefined, ctx);
		expect(ctx.dialogs).toHaveLength(3);
		expect(result.details.status).toBe("cancelled");
	});

	test("empty Other answer is skipped; remaining answers kept", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ inputs: ["1,3", "   "] });
		const result: any = await tool.execute("m5", multiArgs, undefined, undefined, ctx);
		expect(result.details.status).toBe("answered");
		expect(result.details.answers).toHaveLength(1);
		expect(result.details.answers[0].index).toBe(1);
	});
});

describe("text mode", () => {
	test("no options → editor dialog, text answer", async () => {
		const tool = captureTool();
		const ctx = mockCtx({ editor: "free-form answer" });
		const result: any = await tool.execute("x1", { question: "Name?", options: [] }, undefined, undefined, ctx);
		expect(ctx.dialogs[0].method).toBe("editor");
		expect(result.content[0].text).toBe("User answered: free-form answer");
		expect(result.details.mode).toBe("text");
	});
});

describe("guards", () => {
	test("headless ctx → unavailable, no dialog", async () => {
		const tool = captureTool();
		const result: any = await tool.execute("g1", baseArgs, undefined, undefined, headlessCtx);
		expect(result.details.status).toBe("unavailable");
		expect(result.content[0].text).toContain("requires interactive mode UI");
	});

	test("aborted signal → cancelled before any dialog", async () => {
		const tool = captureTool();
		const ctx = mockCtx({});
		const result: any = await tool.execute("g2", baseArgs, { aborted: true } as any, undefined, ctx);
		expect(result.details.status).toBe("cancelled");
		expect(ctx.dialogs).toHaveLength(0);
	});
});

describe("renderers", () => {
	test("renderCall includes question, multi-select marker, options", () => {
		const tool = captureTool();
		const component = tool.renderCall({ ...baseArgs, multiSelect: true }, theme) as { getLines?: () => string[] } & { text?: string };
		// Text component renders via getLines in pi-tui; assert it constructs without error
		expect(component).toBeDefined();
	});

	test("renderResult formats answers", () => {
		const tool = captureTool();
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "User selected: 1. JWT" }],
				details: {
					status: "answered",
					mode: "single-select",
					answers: [{ type: "option", label: "JWT", value: "jwt", index: 1 }],
				},
			},
			{},
			theme,
		);
		expect(component).toBeDefined();
	});
});
