import { describe, expect, test } from "bun:test";
import {
	POOL_DEFAULT_CONCURRENCY,
	POOL_MAX_ITEMS,
	initPool,
	withStandingFooter,
	parsePoolSpec,
	poolSafeRole,
	nextToStart,
	markRunning,
	finishItem,
	gateCheck,
	timeoutRunning,
	aggregateReport,
	detachReply,
	readoptable,
	resumePlan,
	replayPools,
	sanitizePoolState,
	unfinished,
	refreshPoolStatus,
	poolNotice,
	validateTaskInput,
	formatTaskForChild,
	demandsSubmission,
	buildReminderNudge,
	contractErrorNote,
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

describe("readoptable (v1.4.45 — dead-pool freeze regression)", () => {
	const mk = (statuses: string[]) => {
		const st = initPool("p-adopt", statuses.map((s, i) => ({ key: String(i + 1), role: "scout", task: "t" })), 4);
		statuses.forEach((s, i) => {
			if (s === "pending") return;
			markRunning(st, st.items[i].key, `agent-${i + 1}`);
			if (s === "done") finishItem(st, st.items[i].key, { status: "done" });
			else if (s === "failed") finishItem(st, st.items[i].key, { status: "failed" });
			else if (s === "timeout") st.items[i].status = "timeout" as never; // replay-shaped: swept by a prior process
		});
		return st;
	};

	test("running item -> adoptable (respawn re-attach)", () => {
		expect(readoptable(mk(["running", "pending"]))).toBe(true);
	});

	test("all timeout (dead pool, 2026-09-13 incident shape) -> NOT adoptable", () => {
		const st = mk(["timeout", "timeout", "timeout", "timeout"]);
		expect(unfinished(st)).toBe(true); // still unfinished...
		expect(readoptable(st)).toBe(false); // ...but nothing to re-attach to
	});

	test("mixed running + timeout -> adoptable (one live child to drain)", () => {
		expect(readoptable(mk(["timeout", "running"]))).toBe(true);
	});

	test("finished pool (done/failed) -> not adoptable", () => {
		expect(readoptable(mk(["done", "failed"]))).toBe(false);
	});

	test("pending without agentId -> not adoptable (never spawned)", () => {
		const st = initPool("p-p", [{ key: "1", role: "scout", task: "a" }, { key: "2", role: "scout", task: "b" }], 4);
		markRunning(st, st.items[0].key, "agent-1");
		finishItem(st, st.items[0].key, { status: "done" });
		expect(readoptable(st)).toBe(false);
	});
});

describe("poolNotice envelope (#52)", () => {
	test("wraps body with stable open/close tags", () => {
		const out = poolNotice("line one\nline two");
		expect(out.startsWith('<machine-notice kind="pool-notice">')).toBe(true);
		expect(out.endsWith("</machine-notice>")).toBe(true);
		expect(out).toContain("\nline one\nline two\n");
	});
	test("body verbatim — model must read the payload unchanged", () => {
		expect(poolNotice("x")).toContain("\nx\n");
	});
});

describe("standing footer (#58)", () => {
	test("applies once with the ask-and-wait rule", () => {
		const out = withStandingFooter("Read the diff at /tmp/x.diff and brief it.");
		expect(out).toStartWith("Read the diff at /tmp/x.diff and brief it.");
		expect(out).toContain("send message_main describing exactly what you need, then WAIT");
		expect(out).toContain("Never submit a partial report");
	});
	test("idempotent — footer never duplicated", () => {
		const once = withStandingFooter("task");
		expect(withStandingFooter(once)).toBe(once);
		expect(once.match(/Standing rule:/g)).toHaveLength(1);
	});
});

// ── v1.4.89 (#102): structured task schema — hard validator + formatter ──

describe("validateTaskInput (#102)", () => {
	test("plain string passes (legacy, structured=false)", () => {
		const r = validateTaskInput("Find the failing test", "task");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.structured).toBe(false);
	});
	test("empty string rejected with actionable text", () => {
		const r = validateTaskInput("   ", "task");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.text).toContain("must not be empty");
	});
	test("full object passes with structured=true", () => {
		const r = validateTaskInput({ goal: "Ship the fix", context: ["repo at /x"], instructions: "Use research_report" }, "task");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.structured).toBe(true);
			expect(r.task).toEqual({ goal: "Ship the fix", context: ["repo at /x"], instructions: "Use research_report" });
		}
	});
	test("missing goal rejected — names the field", () => {
		const r = validateTaskInput({ context: ["x"] }, "items[0].task");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.text).toContain("items[0].task.goal is required");
	});
	test("unknown field rejected — lists allowed fields (hard validator)", () => {
		const r = validateTaskInput({ goal: "g", prio: 1 }, "task");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.text).toContain('"prio"');
			expect(r.text).toContain("goal, context, instructions");
		}
	});
	test("empty context array rejected (omit instead)", () => {
		const r = validateTaskInput({ goal: "g", context: [] }, "task");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.text).toContain("non-empty array");
	});
	test("non-string instructions rejected", () => {
		const r = validateTaskInput({ goal: "g", instructions: 5 }, "task");
		expect(r.ok).toBe(false);
	});
	test("number input rejected with the expected shape", () => {
		const r = validateTaskInput(42, "task");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.text).toContain("{ goal, context?, instructions? }");
	});
});

describe("formatTaskForChild (#102)", () => {
	test("string passes through unchanged", () => {
		expect(formatTaskForChild("do the thing")).toBe("do the thing");
	});
	test("object renders Goal/Context/Instructions in order, context as bullets", () => {
		const out = formatTaskForChild({ goal: "G", context: ["c1", "c2"], instructions: "I" });
		expect(out).toBe("## Goal\nG\n\n## Context\n- c1\n- c2\n\n## Instructions\nI");
	});
	test("missing sections omitted cleanly", () => {
		const out = formatTaskForChild({ goal: "G" });
		expect(out).toBe("## Goal\nG");
	});
});

describe("parsePoolSpec accepts structured tasks (#102)", () => {
	test("structured item passes and spec.task carries the rendered markdown", () => {
		const r = parsePoolSpec(
				{ items: [{ role: "scout", task: { goal: "Map the module", context: ["src/a.ts"], instructions: "Report via research_report" } }, { role: "scout", task: "plain two" }], concurrency: 2 },
				roles,
			);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.items[0].task).toContain("## Goal\nMap the module");
			expect(r.items[0].task).toContain("- src/a.ts");
			expect(r.items[1].task).toBe("plain two");
		}
	});
	test("malformed structured item rejected with the item index", () => {
		const r = parsePoolSpec(
				{ items: [{ role: "scout", task: { context: ["x"] } }, { role: "scout", task: "ok" }] },
				roles,
			);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.text).toContain("items[0].task.goal is required");
	});
});

// ── v1.4.89 (#102): reminder-once — deterministic contract detection ──

describe("demandsSubmission (#102)", () => {
	test("expect gate demands a submission", () => {
		expect(demandsSubmission("anything", "TOKEN-X")).toBe(true);
	});
	test("task naming research_report or message_main demands one", () => {
		expect(demandsSubmission("Submit via research_report with token T")).toBe(true);
		expect(demandsSubmission("Reply using message_main")).toBe(true);
	});
	test("plain task with no channel and no expect does not", () => {
		expect(demandsSubmission("Read the file and summarize")).toBe(false);
	});
});

describe("buildReminderNudge (#102)", () => {
	test("names research_report + the token when the task used it", () => {
		const n = buildReminderNudge("Submit via research_report", "TOKEN-X");
		expect(n).toContain("[reminder-once]");
		expect(n).toContain("research_report");
		expect(n).toContain('"TOKEN-X"');
		expect(n).toContain("only reminder");
	});
	test("falls back to message_main when only the gate expects a submission", () => {
		const n = buildReminderNudge("Do the research", "TOK");
		expect(n).toContain("message_main");
	});
});

describe("finishItem note (#102)", () => {
	test("note prefixes a gate_failed error (contract-error visible in aggregate)", () => {
		const st = initPool("p1", [{ key: "1", role: "scout", task: "t", expect: "TOKEN" }], 2, "2026-09-17T00:00:00Z");
		markRunning(st, "1", "child-1");
		finishItem(st, "1", { status: "done", report: "no token here", note: contractErrorNote("2026-09-17T01:00:00Z") });
		expect(st.items[0].status).toBe("gate_failed");
		expect(st.items[0].error).toContain("[contract-error]");
		expect(st.items[0].error).toContain("1 reminder sent 2026-09-17T01:00:00Z");
		expect(st.items[0].error).toContain("does not contain the declared substring");
	});
	test("note prefixes a done report when there is no gate", () => {
		const st = initPool("p1", [{ key: "1", role: "scout", task: "t" }], 2);
		markRunning(st, "1", "child-1");
		finishItem(st, "1", { status: "done", report: "digest text", note: contractErrorNote() });
		expect(st.items[0].status).toBe("done");
		expect(st.items[0].report).toContain("[contract-error]");
		expect(st.items[0].report).toContain("digest text");
	});
});

describe("PoolItem.nudged survives the ledger round-trip (#102)", () => {
	test("nudged/nudgedAt persist on the item and replay back", () => {
		const st = initPool("p2", [{ key: "1", role: "scout", task: "t" }], 2);
		markRunning(st, "1", "child-9");
		st.items[0].nudged = true;
		st.items[0].nudgedAt = "2026-09-17T02:00:00Z";
		const replayed = replayPools([{ type: "custom", customType: "pool-state", data: st }]);
		const p = replayed.get("p2");
		expect(p).toBeDefined();
		expect(p?.items[0].nudged).toBe(true);
		expect(p?.items[0].nudgedAt).toBe("2026-09-17T02:00:00Z");
	});
});
