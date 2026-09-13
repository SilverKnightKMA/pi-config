import { describe, expect, test } from "bun:test";
import {
	POOL_DEFAULT_CONCURRENCY,
	POOL_MAX_ITEMS,
	initPool,
	parsePoolSpec,
	poolSafeRole,
	nextToStart,
	markRunning,
	finishItem,
	gateCheck,
	timeoutRunning,
	aggregateReport,
	detachReply,
	resumePlan,
	replayPools,
	sanitizePoolState,
	unfinished,
	refreshPoolStatus,
} from "./pool";

const roles = new Map<string, { tools: readonly string[] }>([
	["scout", { tools: ["read", "grep", "find", "ls"] }],
	["researcher", { tools: ["web_search", "web_fetch", "safe_bash", "read"] }],
	["worker", { tools: ["read", "write", "edit", "bash", "spawn_subagent"] }],
]);

const spec = (items: unknown[], concurrency?: number) => parsePoolSpec({ items, concurrency }, roles);

describe("poolSafeRole — single-writer doctrine gate", () => {
	test("scout + researcher safe; worker (write/edit/bash) unsafe", () => {
		expect(poolSafeRole("scout", roles)).toBe(true);
		expect(poolSafeRole("researcher", roles)).toBe(true);
		expect(poolSafeRole("worker", roles)).toBe(false);
	});
	test("unknown role unsafe; SUBAGENT_POOL_EXTRA_ROLES bonus opts in", () => {
		expect(poolSafeRole("ghost", roles)).toBe(false);
		expect(poolSafeRole("worker", roles, new Set(["worker"]))).toBe(true);
	});
});

describe("parsePoolSpec", () => {
	const two = [
		{ role: "scout", task: "map extensions dir" },
		{ role: "researcher", task: "survey fan-out tools", expect: "VERDICT" },
	];

	test("happy path: 2 items, defaults", () => {
		const r = spec(two);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.items).toHaveLength(2);
		expect(r.items[0].key).toBe("1");
		expect(r.items[1].expect).toBe("VERDICT");
		expect(r.concurrency).toBe(POOL_DEFAULT_CONCURRENCY);
	});

	test("1 item rejected — that is spawn_paseo_subagent's job", () => {
		const r = spec([{ role: "scout", task: "solo" }]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.text).toContain("spawn_paseo_subagent");
	});

	test(`over ${POOL_MAX_ITEMS} items rejected`, () => {
		const many = Array.from({ length: 13 }, (_, i) => ({ role: "scout", task: `t${i}` }));
		expect(spec(many).ok).toBe(false);
	});

	test("write-capable role rejected with the safe list named", () => {
		const r = spec([
			{ role: "scout", task: "a" },
			{ role: "worker", task: "b" },
		]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.text).toContain("worker");
		expect(r.text).toContain("scout");
		expect(r.text).toContain("researcher");
	});

	test("duplicate names rejected; empty expect rejected; concurrency clamped", () => {
		expect(spec([
			{ role: "scout", task: "a", name: "x" },
			{ role: "scout", task: "b", name: "x" },
		]).ok).toBe(false);
		expect(spec([
			{ role: "scout", task: "a" },
			{ role: "scout", task: "b", expect: "  " },
		]).ok).toBe(false);
		const r = spec([
			{ role: "scout", task: "a" },
			{ role: "scout", task: "b" },
		], 99);
		expect(r.ok && r.concurrency).toBe(4);
	});
});

describe("scheduler state machine", () => {
	const mk = () => initPool("p1", [
		{ key: "1", role: "scout", task: "a" },
		{ key: "2", role: "scout", task: "b" },
		{ key: "3", role: "scout", task: "c" },
	], 2);

	test("nextToStart respects free slots", () => {
		const st = mk();
		expect(nextToStart(st).map((i) => i.key)).toEqual(["1", "2"]);
		markRunning(st, "1", "agent-1");
		markRunning(st, "2", "agent-2");
		expect(nextToStart(st)).toEqual([]);
		finishItem(st, "1", { status: "done", report: "ok" });
		expect(nextToStart(st).map((i) => i.key)).toEqual(["3"]);
	});

	test("markRunning ignores non-pending items (idempotent replay safety)", () => {
		const st = mk();
		markRunning(st, "1", "a1");
		markRunning(st, "1", "a2");
		expect(st.items[0].agentId).toBe("a1");
	});

	test("finishItem: done without expect → done; with expect miss → gate_failed", () => {
		const st = initPool("p", [
			{ key: "1", role: "researcher", task: "a", expect: "VERDICT" },
			{ key: "2", role: "scout", task: "b" },
		], 2);
		finishItem(st, "1", { status: "done", report: "long survey, no verdict line" });
		expect(st.items[0].status).toBe("gate_failed");
		expect(st.items[0].error).toContain("VERDICT");
		finishItem(st, "2", { status: "done", report: "mapped" });
		expect(st.items[1].status).toBe("done");
	});

	test("failed carries error; timeoutRunning marks only running", () => {
		const st = mk();
		markRunning(st, "1", "a1");
		finishItem(st, "1", { status: "failed", error: "spawn failed" });
		markRunning(st, "2", "a2");
		timeoutRunning(st);
		expect(st.items[0].status).toBe("failed");
		expect(st.items[1].status).toBe("timeout");
		expect(st.items[2].status).toBe("pending");
	});
});

describe("gateCheck", () => {
	test("no expect always passes; substring must literally appear", () => {
		expect(gateCheck(undefined, undefined).ok).toBe(true);
		expect(gateCheck("OK", "result: OK done").ok).toBe(true);
		expect(gateCheck("OK", "nope").ok).toBe(false);
	});
});

describe("aggregateReport + resumePlan", () => {
	test("counts + per-item lines + resume hint when unfinished", () => {
		const st = initPool("p9", [
			{ key: "1", role: "scout", task: "a" },
			{ key: "2", role: "researcher", task: "b", expect: "V" },
			{ key: "3", role: "scout", task: "c" },
		], 2);
		finishItem(st, "1", { status: "done", report: "mapped 12 files" });
		finishItem(st, "2", { status: "done", report: "survey without verdict" });
		refreshPoolStatus(st);
		expect(st.status).toBe("partial");
		const text = aggregateReport(st);
		expect(text).toContain("1/3 done");
		expect(text).toContain("△");
		expect(text).toContain("gate_failed");
		expect(text).toContain('pool_resume("p9")');
		const plan = resumePlan(st);
		expect(plan.spawn.map((i) => i.key)).toEqual(["3"]);
		expect(plan.recheck).toEqual([]);
	});

	test("complete pool reports complete, no resume hint", () => {
		const st = initPool("p8", [
			{ key: "1", role: "scout", task: "a" },
			{ key: "2", role: "scout", task: "b" },
		], 2);
		finishItem(st, "1", { status: "done", report: "a" });
		finishItem(st, "2", { status: "done", report: "b" });
		refreshPoolStatus(st);
		expect(st.status).toBe("done");
		expect(aggregateReport(st)).toContain("(complete)");
		expect(aggregateReport(st)).not.toContain("pool_resume");
	});
});

describe("ledger replay (resume across respawn)", () => {
	test("replayPools: last snapshot per poolId wins; junk ignored", () => {
		const st1 = initPool("p1", [{ key: "1", role: "scout", task: "a" }], 1);
		markRunning(st1, "1", "agent-x");
		const st2 = initPool("p1", [{ key: "1", role: "scout", task: "a" }], 1);
		markRunning(st2, "1", "agent-x");
		finishItem(st2, "1", { status: "done", report: "finished after respawn" });
		const pools = replayPools([
			{ type: "custom", customType: "pool-state", data: st1 },
			{ type: "custom", customType: "unrelated", data: { nope: 1 } },
			{ type: "custom", customType: "pool-state", data: st2 },
			{ type: "custom", customType: "pool-state", data: { poolId: "broken" } },
		]);
		expect(pools.size).toBe(1);
		expect(pools.get("p1")?.items[0].status).toBe("done");
	});

	test("sanitizePoolState recomputes status and clips long reports", () => {
		const st = initPool("p2", [
			{ key: "1", role: "scout", task: "a" },
			{ key: "2", role: "scout", task: "b" },
		], 2);
		finishItem(st, "1", { status: "done", report: "x".repeat(5000) });
		const out = sanitizePoolState(JSON.parse(JSON.stringify(st)));
		expect(out).not.toBeNull();
		expect(out!.items[0].report!.length).toBeLessThanOrEqual(2001);
		expect(out!.status).toBe("partial");
		expect(unfinished(out!)).toBe(true);
	});
});

describe("detachReply (v1.4.44 fire-and-forget)", () => {
	test("names the pool, counts queued, states ONE aggregate + timeout", () => {
		const r = spec([{ role: "scout", task: "a" }, { role: "scout", task: "b" }, { role: "scout", task: "c" }], 2);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const st = initPool("p-det", r.items, r.concurrency);
		markRunning(st, st.items[0].key, "agent-1");
		markRunning(st, st.items[1].key, "agent-2");
		const text = detachReply(st, 45 * 60_000);
		expect(text.includes(st.poolId)).toBe(true);
		expect(text.includes("DETACHED")).toBe(true);
		expect(text.includes("1 queued")).toBe(true);
		expect(text.includes("45min")).toBe(true);
		expect(text.includes("pool_status")).toBe(true);
	});

	test("no pending items -> 0 queued", () => {
		const st = initPool("p-det2", [
			{ key: "1", role: "scout", task: "a" },
			{ key: "2", role: "scout", task: "b" },
		], 4);
		markRunning(st, st.items[0].key, "agent-1");
		markRunning(st, st.items[1].key, "agent-2");
		const text = detachReply(st, 60_000);
		expect(text.includes("0 queued")).toBe(true);
		expect(text.includes("1min")).toBe(true);
	});
});
