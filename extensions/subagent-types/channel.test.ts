import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushToQueue, drainQueue, queueFile, renderForPrompt, type ChannelMessage } from "./paseo-channel.ts";

let base: string;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "paseo-chan-test-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function msg(i: number, over: Partial<ChannelMessage> = {}): ChannelMessage {
	return { id: `m${i}`, from: `child-${i}`, fromRole: "scout", text: `hello ${i}`, ts: `t${i}`, kind: "message", ...over };
}

describe("file queue — push/drain roundtrip", () => {
	test("push then drain returns entries in order", () => {
		pushToQueue("agent-a", msg(1), base);
		pushToQueue("agent-a", msg(2), base);
		pushToQueue("agent-a", msg(3), base);
		const got = drainQueue("agent-a", base);
		expect(got.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
	});

	test("drain removes the file — second drain returns []", () => {
		pushToQueue("agent-a", msg(1), base);
		expect(drainQueue("agent-a", base).length).toBe(1);
		expect(drainQueue("agent-a", base)).toEqual([]);
		expect(existsSync(queueFile("agent-a", base))).toBe(false);
	});

	test("drain with no queue file is [] (no throw)", () => {
		expect(drainQueue("never-pushed", base)).toEqual([]);
	});

	test("agents are isolated — one file per agent id", () => {
		pushToQueue("agent-a", msg(1), base);
		pushToQueue("agent-b", msg(2), base);
		const a = drainQueue("agent-a", base);
		expect(a.map((m) => m.id)).toEqual(["m1"]);
		expect(drainQueue("agent-b", base).map((m) => m.id)).toEqual(["m2"]);
	});

	test("messages appended AFTER a drain survive for the next drain (rename-safety)", () => {
		pushToQueue("agent-a", msg(1), base);
		const first = drainQueue("agent-a", base);
		expect(first.length).toBe(1);
		// writer appends post-rename → fresh file
		pushToQueue("agent-a", msg(2), base);
		const second = drainQueue("agent-a", base);
		expect(second.map((m) => m.id)).toEqual(["m2"]);
	});

	test("torn tail line (crash mid-write) is dropped, valid lines survive", () => {
		pushToQueue("agent-a", msg(1), base);
		const f = queueFile("agent-a", base);
		// simulate a half-written JSON line
		Bun.write(f, readFileSync(f, "utf-8") + '{"id":"torn","from":"ch', { createPath: false });
		const got = drainQueue("agent-a", base);
		expect(got.map((m) => m.id)).toEqual(["m1"]);
	});

	test("queue is persistent on disk (crash-safe by construction)", () => {
		pushToQueue("agent-a", msg(1), base);
		expect(existsSync(queueFile("agent-a", base))).toBe(true);
	});
});

describe("renderForPrompt", () => {
	test("wraps each message in a subagent-message block with kind", () => {
		const out = renderForPrompt([msg(1), msg(2, { kind: "ask" })]);
		expect(out).toContain('<subagent-message from="child-1" role="scout" kind="message">');
		expect(out).toContain("hello 1");
		expect(out).toContain('kind="ask"');
		expect(out).toContain("</subagent-message>");
	});

	test("multiple messages joined with blank line", () => {
		const out = renderForPrompt([msg(1), msg(2)]);
		expect(out.split("</subagent-message>\n\n<subagent-message").length).toBe(2);
	});
});

import { loadRegistry, registerSubagent, resolveSubagentName, waitForReply } from "./paseo-channel.ts";

describe("name registry", () => {
	test("register → resolve roundtrip", () => {
		registerSubagent("mapper", { agentId: "a-1", role: "scout", createdAt: "t0" }, base);
		registerSubagent("drawer", { agentId: "b-1", role: "svg-maker", createdAt: "t1" }, base);
		expect(resolveSubagentName("mapper", base)?.agentId).toBe("a-1");
		expect(resolveSubagentName("drawer", base)?.role).toBe("svg-maker");
	});

	test("same name re-spawned → latest wins", () => {
		registerSubagent("mapper", { agentId: "a-1", role: "scout", createdAt: "t0" }, base);
		registerSubagent("mapper", { agentId: "a-2", role: "scout", createdAt: "t1" }, base);
		expect(resolveSubagentName("mapper", base)?.agentId).toBe("a-2");
	});

	test("unknown name → undefined", () => {
		expect(resolveSubagentName("ghost", base)).toBeUndefined();
	});

	test("corrupt registry file → empty, not fatal", () => {
		registerSubagent("x", { agentId: "x-1", role: "worker", createdAt: "t0" }, base);
		Bun.write(join(base, "subagent-channel", "registry.json"), "{corrupt", { createPath: false });
		expect(loadRegistry(base)).toEqual({});
	});
});

describe("waitForReply", () => {
	test("reply already queued → resolves immediately", async () => {
		pushToQueue("me-1", msg(1, { kind: "reply" }), base);
		const got = await waitForReply("me-1", 100, base, 20);
		expect(got?.text).toBe("hello 1");
	});

	test("no reply → undefined on timeout", async () => {
		const got = await waitForReply("me-2", 80, base, 20);
		expect(got).toBeUndefined();
	});

	test("reply landing mid-wait → absorbed", async () => {
		setTimeout(() => pushToQueue("me-3", msg(9, { kind: "reply" }), base), 60);
		const got = await waitForReply("me-3", 1_000, base, 20);
		expect(got?.id).toBe("m9");
	});
});
