import { describe, expect, test } from "bun:test";

import { buildSpawnCliArgs, parseCliSpawnOutput, replyDoorNote, MODE_KNOBS, validModeKnob } from "./paseo-channel.ts";

describe("buildSpawnCliArgs (#120 reply-door carrier)", () => {
	test("env carrier + mode + labels + thinking, prompt last", () => {
		const args = buildSpawnCliArgs({
			provider: "codex/gpt-5.6-luna",
			title: "scout-child",
			labels: { "subagent.role": "scout", "subagent.parent": "p-1" },
			initialPrompt: "do the thing",
			thinkingOptionId: "",
			parentAgentId: "p-1",
			mode: "review",
		});
		expect(args[0]).toBe("run");
		expect(args).toContain("-d");
		expect(args).toContain("--json");
		expect(args).toContain("--provider");
		expect(args[args.indexOf("--provider") + 1]).toBe("codex/gpt-5.6-luna");
		expect(args).toContain("--env");
		expect(args[args.indexOf("--env") + 1]).toBe("PASEO_PARENT_AGENT_ID=p-1");
		expect(args).toContain("PASEO_CHILD_MODE=review");
		expect(args).toContain("subagent.role=scout");
		expect(args[args.length - 1]).toBe("do the thing");
	});

	test("pi child: thinking flag present, no mode by default", () => {
		const args = buildSpawnCliArgs({
			provider: "pi/cli-openai/zaicp/glm-5.3",
			title: "t",
			labels: {},
			initialPrompt: "x",
			thinkingOptionId: "high",
			parentAgentId: "p",
		});
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
		expect(args.filter((a) => a === "--thinking")).toHaveLength(1);
		expect(args.filter((a) => a.startsWith("PASEO_CHILD_MODE="))).toHaveLength(0);
	});

	test("empty thinking omitted", () => {
		const args = buildSpawnCliArgs({
			provider: "claude/opus",
			title: "t",
			labels: {},
			initialPrompt: "x",
			thinkingOptionId: "",
			parentAgentId: "p",
			mode: "auto",
		});
		expect(args).not.toContain("--thinking");
	});
});

describe("parseCliSpawnOutput", () => {
	test("plain JSON object", () => {
		expect(parseCliSpawnOutput('{"agentId":"abc","status":"running"}')).toEqual({ agentId: "abc", status: "running" });
	});
	test("JSON buried in lines (CLI prefix noise)", () => {
		const out = 'Trusting plugin code...\n{"agentId":"zzz"}\n';
		expect(parseCliSpawnOutput(out)?.agentId).toBe("zzz");
	});
	test("no agentId -> null", () => {
		expect(parseCliSpawnOutput("error: boom")).toBeNull();
		expect(parseCliSpawnOutput('{"status":"running"}')).toBeNull();
	});
});

describe("mode knob (#120)", () => {
	test("four knobs", () => {
		expect([...MODE_KNOBS]).toEqual(["read-only", "auto", "review", "full"]);
	});
	test("validation", () => {
		for (const k of ["read-only", "auto", "review", "full"]) expect(validModeKnob(k)).toBe(true);
		expect(validModeKnob(undefined)).toBe(true);
		expect(validModeKnob("full-access")).toBe(false);
		expect(validModeKnob("bypassPermissions")).toBe(false);
	});
});

describe("replyDoorNote", () => {
	test("foreign: names reply_to_parent, forbids other channels", () => {
		const t = replyDoorNote(true);
		expect(t).toContain("reply_to_parent");
		expect(t).toContain("ONLY channel");
		expect(t).not.toContain("message_main");
	});
	test("pi: message_main preferred, reply_to_parent fallback, no duplication", () => {
		const t = replyDoorNote(false);
		expect(t).toContain("message_main");
		expect(t).toContain("reply_to_parent");
		expect(t).toContain("never duplicate");
	});
});
