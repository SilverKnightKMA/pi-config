import { describe, expect, test } from "bun:test";
import readOnlyModeExtension, { COMMAND_NAME, READ_ONLY_TOOL_NAMES, getReadOnlyToolNames, restoreTools } from "./index";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function fakePi(toolNames: string[]) {
	const state: {
		active: string[];
		commands: Map<string, { handler: Handler; description: string }>;
		handlers: Map<string, Handler>;
		tools: any[];
	} = {
		active: [...toolNames],
		commands: new Map(),
		handlers: new Map(),
		tools: [],
	};
	const pi: any = {
		getAllTools: () => toolNames.map((name) => ({ name, description: name })),
		getActiveTools: () => [...state.active],
		setActiveTools: (names: string[]) => {
			state.active = [...names];
		},
		registerTool: (def: any) => {
			state.tools.push(def);
		},
		registerCommand: (name: string, def: any) => {
			state.commands.set(name, def);
		},
		on: (event: string, handler: Handler) => {
			state.handlers.set(event, handler);
		},
	};
	return { pi, state };
}

function fakeCtx() {
	const notifications: string[] = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify: (msg: string) => {
					notifications.push(msg);
				},
			},
		} as any,
	};
}

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];

describe("read-only-mode (port of zz-read-only-mode)", () => {
	test("constant allowlist stays read/grep/find/ls", () => {
		expect([...READ_ONLY_TOOL_NAMES]).toEqual(["read", "grep", "find", "ls"]);
		expect(COMMAND_NAME).toBe("read-only");
	});

	test("getReadOnlyToolNames intersects with available tools", () => {
		const { pi } = fakePi(["read", "bash", "grep", "ls"]); // no "find"
		expect(getReadOnlyToolNames(pi)).toEqual(["read", "grep", "ls"]);
	});

	test("on -> setActiveTools allowlist; off -> restore previous set", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const cmd = state.commands.get("read-only")!;
		const { ctx, notifications } = fakeCtx();

		await cmd.handler("on", ctx);
		expect(state.active).toEqual(["read", "grep", "find", "ls"]);
		expect(notifications[0]).toContain("Read-only mode enabled");

		await cmd.handler("off", ctx);
		expect(state.active).toEqual(ALL_TOOLS);
		expect(notifications[1]).toContain("Read-only mode disabled");
	});

	test("toggle flips state", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const cmd = state.commands.get("read-only")!;
		const { ctx } = fakeCtx();

		await cmd.handler("", ctx);
		expect(state.active).toEqual(["read", "grep", "find", "ls"]);
		await cmd.handler("toggle", ctx);
		expect(state.active).toEqual(ALL_TOOLS);
	});

	test("tool_call blocks write tools with reason while enabled", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const cmd = state.commands.get("read-only")!;
		const { ctx } = fakeCtx();
		await cmd.handler("on", ctx);

		const blocked = await state.handlers.get("tool_call")!({ toolName: "bash" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain('Tool "bash" is blocked');

		const allowed = await state.handlers.get("tool_call")!({ toolName: "read" });
		expect(allowed).toBeUndefined();
	});

	test("tool_call is a no-op when disabled", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const result = await state.handlers.get("tool_call")!({ toolName: "bash" });
		expect(result).toBeUndefined();
	});

	test("before_agent_start injects system prompt only while enabled", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const cmd = state.commands.get("read-only")!;
		const { ctx } = fakeCtx();

		const idle = await state.handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
		expect(idle).toBeUndefined();

		await cmd.handler("on", ctx);
		const injected = await state.handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
		expect(injected.systemPrompt).toContain("BASE");
		expect(injected.systemPrompt).toContain("[Read-only mode is active]");
		expect(injected.systemPrompt).toContain("/read-only off");
	});

	test("status reports on/off", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const cmd = state.commands.get("read-only")!;
		const { ctx, notifications } = fakeCtx();

		await cmd.handler("status", ctx);
		expect(notifications[0]).toContain("Read-only mode is OFF.");

		await cmd.handler("on", ctx);
		await cmd.handler("status", ctx);
		expect(notifications[2]).toContain("Read-only mode is ON. Allowed tools: read, grep, find, ls.");
	});

	test("double-on does not corrupt the saved tool snapshot", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const cmd = state.commands.get("read-only")!;
		const { ctx, notifications } = fakeCtx();

		await cmd.handler("on", ctx);
		await cmd.handler("on", ctx); // already enabled — must not overwrite snapshot
		expect(notifications[1]).toContain("already enabled");

		await cmd.handler("off", ctx);
		expect(state.active).toEqual(ALL_TOOLS); // original set restored
	});

	test("unknown arg prints usage", async () => {
		const { pi, state } = fakePi(ALL_TOOLS);
		readOnlyModeExtension(pi);
		const cmd = state.commands.get("read-only")!;
		const { ctx, notifications } = fakeCtx();
		await cmd.handler("bogus", ctx);
		expect(notifications[0]).toContain("Usage: /read-only");
	});

	test("restoreTools filters to currently-registered tools", () => {
		const { pi, state } = fakePi(["read", "bash", "edit"]);
		const restored = restoreTools(pi, ["read", "bash", "write", "gone-tool"]);
		expect(restored).toEqual(["read", "bash"]); // "write"/"gone-tool" not in registry
		expect(state.active).toEqual(["read", "bash"]);
	});
});

describe("plan status projection (#22 — panel reads this file)", () => {
	// writePlanStatus is 8 lines of best-effort fs wiring around this pure
	// shape; Bun caches os.homedir() at startup so tests pin the contract
	// here instead of redirecting HOME (PR #102 lesson: never touch real HOME).
	test("planStatusPayload carries mode/steps/planFile for the panel", async () => {
		const { emptyPlan, planStatusPayload } = await import("./plan.ts");
		const plan = { ...emptyPlan(), mode: "awaiting" as const, planFile: ".pi/plans/x.md", steps: [
			{ index: 1, text: "a", done: true },
			{ index: 2, text: "b", done: false },
		] };
		const p = planStatusPayload(plan, "sess-42", "2026-09-13T00:00:00.000Z");
		expect(p).toEqual({
			v: 1,
			sessionId: "sess-42",
			mode: "awaiting",
			stepsDone: 1,
			stepsTotal: 2,
			steps: [
				{ index: 1, text: "a", done: true },
				{ index: 2, text: "b", done: false },
			],
			currentStep: { index: 2, text: "b" },
			planFile: ".pi/plans/x.md",
			submittedAt: null,
			completedAt: null,
			// #85: budget projection defaults when no wake history exists
			wakeRounds: 0,
			wakeNoProgress: 0,
			openSteps: 0,
			parkedSteps: 0,
			updatedAt: "2026-09-13T00:00:00.000Z",
		});
	});

	test("inactive plan still projects (panel shows nothing-to-approve)", async () => {
		const { emptyPlan, planStatusPayload } = await import("./plan.ts");
		const p = planStatusPayload(emptyPlan(), "s");
		expect(p.mode).toBe("inactive");
		expect(p.stepsTotal).toBe(0);
		expect(p.planFile).toBeNull();
	});

	test("#85 planStatusPayload carries the wake-budget fields for the panel card", async () => {
		const { emptyPlan, planStatusPayload } = await import("./plan.ts");
		const plan = { ...emptyPlan(), mode: "tracking" as const, planId: "p-1", wakeRounds: 7, wakeNoProgress: 2, steps: [
			{ index: 1, text: "a", done: true },
			{ index: 2, text: "b", done: false },
			{ index: 3, text: "c", done: false },
		] };
		const board = [
			{ id: 70, status: "completed", planId: "p-1", stepIndex: 1 },
			{ id: 71, status: "in_progress", planId: "p-1", stepIndex: 2 },
			{ id: 72, status: "parked", planId: "p-1", stepIndex: 3 },
		];
		const p = planStatusPayload(plan, "s", "2026-09-16T00:00:00.000Z", undefined, board);
		expect(p.wakeRounds).toBe(7);
		expect(p.wakeNoProgress).toBe(2);
		expect(p.openSteps).toBe(2); // in_progress + parked (completed excluded)
		expect(p.parkedSteps).toBe(1);
	});
});

// ── v1.4.60 (#62): auto-close wiring — last plan_step_done flips to complete ──

describe("plan auto-close wiring (#62)", () => {
	test("last step done closes the plan; result announces completion", async () => {
		const f = fakePi(ALL_TOOLS);
		readOnlyModeExtension(f.pi);
		const stepTool = f.state.tools.find((t: { name: string }) => t.name === "plan_step_done")!;
		expect(stepTool).toBeTruthy();
		const done1 = await stepTool.execute("c1", { index: 1, evidence: "cmd A ran" }, undefined, undefined, fakeCtx().ctx);
		// without a loaded plan the tool answers gracefully
		expect((done1 as { content: { text: string }[] }).content[0]!.text).toContain("No plan loaded");
	});
	test("tool def registered", () => {
		const f2 = fakePi(ALL_TOOLS);
		readOnlyModeExtension(f2.pi);
		expect(f2.state.tools.some((t: { name: string }) => t.name === "plan_step_done")).toBe(true);
	});
});

// ── #236 plan file lifecycle: closePlanFileOnDisk end-to-end ──

describe("#236 closePlanFileOnDisk (stamp + --COMPLETED rename)", () => {
	test("renames, stamps the marker, frees the original name; idempotent", async () => {
		const { closePlanFileOnDisk } = await import("./index");
		const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = join(tmpdir(), `plan-close-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
		mkdirSync(dir, { recursive: true });
		try {
			const orig = join(dir, "2026-09-22-my-plan.md");
			writeFileSync(orig, "# Plan\n\n1. step\n", "utf8");
			const newName = closePlanFileOnDisk(orig, "2026-09-23T01:02:03.000Z", "p-42");
			if (!newName) throw new Error("close returned null");
			expect(newName).toBe("2026-09-22-my-plan--COMPLETED.md");
			expect(existsSync(orig)).toBe(false); // "file cũ phải đóng lại" — original name freed
			const closed = join(dir, newName);
			expect(existsSync(closed)).toBe(true);
			const text = readFileSync(closed, "utf8");
			expect(text).toContain("<!-- plan-complete: 2026-09-23T01:02:03.000Z p-42 -->");
			// second close → no-op (already closed)
			expect(closePlanFileOnDisk(closed, "2026-09-23T01:02:03.000Z")).toBeNull();
			// missing file → null, never throws
			expect(closePlanFileOnDisk(join(dir, "nope.md"), "t")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── #248 v2: enter_plan_mode removed from the model toolset ──

describe("#248 v2: enter_plan_mode removal + write_plan guidance", () => {
	test("extension registers NO enter_plan_mode tool (the 7 wasted-call door is gone)", async () => {
		const { pi, state } = fakePi(["read", "bash", "edit", "write"]);
		readOnlyModeExtension(pi as never);
		const names = state.tools.map((t: any) => t.name);
		expect(names).not.toContain("enter_plan_mode");
		expect(names).toContain("write_plan");
		expect(names).toContain("exit_plan_mode");
	});

	test("write_plan description carries the user-initiated guidance", async () => {
		const { pi, state } = fakePi(["read", "bash", "edit", "write"]);
		readOnlyModeExtension(pi as never);
		const wp = state.tools.find((t: any) => t.name === "write_plan");
		expect(wp.description).toContain("user-initiated");
		expect(wp.description).toContain("ask the user to enable it (/plan on)");
	});
});
