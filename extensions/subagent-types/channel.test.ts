import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushToQueue, drainQueue, queueFile, renderForPrompt, markKick, flushKicks, pendingKickIds, type ChannelMessage } from "./paseo-channel.ts";

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

// ── Deferred kicks (2026-09-01): queue-only in execute, kick at turn_end ──
const kickBase = mkdtempSync(join(tmpdir(), "kicks-"));
const fakeEp = { url: "http://fake" } as never;

test("flushKicks kicks an idle child with queued messages and empties the queue", async () => {
	pushToQueue("kid-idle", { id: "m1", from: "main", fromRole: "main", text: "hello kid", ts: "t" }, kickBase);
	markKick("kid-idle", false);
	const calls: Array<{ method: string; params: any }> = [];
	const out = await flushKicks(fakeEp, {
		base: kickBase,
		call: async (_e: any, method: string, params: any) => { calls.push({ method, params }); return { ok: true, data: {} }; },
		status: async () => ({ ok: true, status: "idle" }),
	});
	expect(out[0]?.kicked).toBe(true);
	expect(calls[0]?.method).toBe("send_agent_prompt");
	expect(calls[0]?.params.notifyOnFinish).toBe(false); // mid-turn notifications abort the parent
	expect(calls[0]?.params.prompt).toContain("hello kid");
	expect(drainQueue("kid-idle", kickBase)).toHaveLength(0);
	expect(pendingKickIds()).not.toContain("kid-idle");
});

test("flushKicks leaves a busy child to its own drain (no send)", async () => {
	pushToQueue("kid-busy", { id: "m2", from: "main", fromRole: "main", text: "later", ts: "t" }, kickBase);
	markKick("kid-busy", false);
	let sent = 0;
	const out = await flushKicks(fakeEp, {
		base: kickBase,
		call: async () => { sent++; return { ok: true, data: {} }; },
		status: async () => ({ ok: true, status: "running" }),
	});
	expect(out[0]?.kicked).toBe(false);
	expect(sent).toBe(0);
	expect(drainQueue("kid-busy", kickBase)).toHaveLength(1); // queue intact for the child's drain
	expect(pendingKickIds()).not.toContain("kid-busy");
});

test("interrupt semantics kick even a busy child", async () => {
	pushToQueue("kid-int", { id: "m3", from: "main", fromRole: "main", text: "pivot", ts: "t" }, kickBase);
	markKick("kid-int", true);
	let sent = 0;
	const out = await flushKicks(fakeEp, {
		base: kickBase,
		call: async () => { sent++; return { ok: true, data: {} }; },
		status: async () => ({ ok: true, status: "running" }),
	});
	expect(out[0]?.kicked).toBe(true);
	expect(sent).toBe(1);
});

test("failed send re-queues and keeps the marker for the next flush", async () => {
	pushToQueue("kid-fail", { id: "m4", from: "main", fromRole: "main", text: "retry me", ts: "t" }, kickBase);
	markKick("kid-fail", false);
	const out = await flushKicks(fakeEp, {
		base: kickBase,
		call: async () => ({ ok: false, error: "boom" }),
		status: async () => ({ ok: true, status: "finished" }),
	});
	expect(out[0]?.kicked).toBe(false);
	expect(out[0]?.reason).toContain("boom");
	expect(drainQueue("kid-fail", kickBase)).toHaveLength(1); // re-queued
	expect(pendingKickIds()).toContain("kid-fail");
});

test("empty queue (child already drained) is a no-op kick", async () => {
	markKick("kid-empty", false);
	let sent = 0;
	const out = await flushKicks(fakeEp, {
		base: kickBase,
		call: async () => { sent++; return { ok: true, data: {} }; },
		status: async () => ({ ok: true, status: "idle" }),
	});
	expect(out[0]?.kicked).toBe(false);
	expect(out[0]?.reason).toContain("empty");
	expect(sent).toBe(0);
});

// ── Auto-report backstop (2026-09-02): ping-only khi child settle mà quên message_main ──
import { shouldAutoPing, buildAutoPing } from "./index.ts";

test("shouldAutoPing chỉ cho subagent chưa gọi message_main", () => {
	expect(shouldAutoPing("researcher", false, true)).toBe(true);
	expect(shouldAutoPing("researcher", true, true)).toBe(false);   // đã chủ động báo
	expect(shouldAutoPing("main", false, true)).toBe(false);          // main không tự ping
	expect(shouldAutoPing(undefined, false, true)).toBe(false);       // chưa resolve identity
	expect(shouldAutoPing("worker", false, false)).toBe(false);       // identity chưa chắc
});

test("buildAutoPing: 1 dòng, có role + agentId + hướng dẫn paseo_activity, KHÔNG chứa payload", () => {
	const t = buildAutoPing("researcher", "01a05f8e", "Đối chiếu case zippo với 780T/500R stock");
	expect(t).toContain("researcher");
	expect(t).toContain("01a05f8e");
	expect(t).toContain("paseo_activity");
	expect(t.startsWith("[auto-report]")).toBe(true);
	expect(t.length).toBeLessThan(300); // ping phải ngắn — không nhân bản văn bản con
});

test("buildAutoPing không title vẫn hợp lệ", () => {
	const t = buildAutoPing("scout", "abc", undefined);
	expect(t).toContain("scout");
	expect(t).not.toContain("undefined");
});

// ── Main-tool restriction (2026-09-02): deny-list cho main agent ──
import { mergeMainBlockedTools } from "./index.ts";

test("mergeMainBlockedTools: workspace thắng user-wide, user-wide thắng rỗng", () => {
	expect(mergeMainBlockedTools({ subagentTypes: { mainBlockedTools: ["safe_bash"] } }, { subagentTypes: { mainBlockedTools: ["web_search"] } })).toEqual(["safe_bash"]);
	expect(mergeMainBlockedTools(null, { subagentTypes: { mainBlockedTools: ["web_search"] } })).toEqual(["web_search"]);
	expect(mergeMainBlockedTools({ subagentTypes: {} }, { subagentTypes: { mainBlockedTools: ["web_search"] } })).toEqual(["web_search"]); // ws có key rỗng → fallback
	expect(mergeMainBlockedTools(null, null)).toEqual([]);
});

test("mergeMainBlockedTools lọc phần tử rác, không vỡ với kiểu sai", () => {
	expect(mergeMainBlockedTools({ subagentTypes: { mainBlockedTools: ["safe_bash", 42, null, "web_fetch"] } }, null)).toEqual(["safe_bash", "web_fetch"]);
	expect(mergeMainBlockedTools({ subagentTypes: { mainBlockedTools: "not-an-array" } }, null)).toEqual([]);
});
