import { describe, expect, test } from "bun:test";
import readOnlyModeExtension, { COMMAND_NAME, READ_ONLY_TOOL_NAMES, getReadOnlyToolNames, restoreTools } from "./index";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function fakePi(toolNames: string[]) {
	const state: {
		active: string[];
		commands: Map<string, { handler: Handler; description: string }>;
		handlers: Map<string, Handler>;
		tools: { name: string }[];
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
			state.tools.push({ name: def.name });
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
