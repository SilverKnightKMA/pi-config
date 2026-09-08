/**
 * Tests for the task extension port (pifydev/task @ 0.3.0).
 *
 * Two layers:
 * 1. Upstream pure-function tests, ported verbatim from test/task.test.ts +
 *    test/nudge.test.ts (node:test -> bun:test; node:assert kept as-is).
 * 2. Wiring tests against a fake pi API (lesson from the sse-probe v1.4.12
 *    regression: pure-function tests miss event/tool-shape contracts).
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	TASK_STATE,
	createTask,
	newlyReady,
	openBlockers,
	readyTasks,
	replayBranch,
	updateTask,
	wouldCycle,
} from "./src/graph.ts";
import { buildCompletionSweep, buildNudge, classifyTurn, completionSignature, shouldNudge } from "./src/nudge.ts";
import { buildWidgetLines } from "./src/widget.ts";
import { buildTaskStatus, taskStatusPath } from "./src/status-file.ts";
import { EMPTY_STATE, type TaskState, type ThemeLike } from "./src/types.ts";
import taskExtension from "./index.ts";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const theme: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

function seed(): TaskState {
	let s = EMPTY_STATE;
	s = createTask(s, "design schema", "", [], 1).state; // #1
	s = createTask(s, "implement api", "", [1], 2).state; // #2 blocked by #1
	s = createTask(s, "write docs", "", [], 3).state; // #3
	return s;
}

test("createTask assigns ids and maintains reverse links", () => {
	const s = seed();
	assert.equal(s.tasks.length, 3);
	assert.deepEqual(s.tasks.find((t) => t.id === 1)!.blocks, [2]);
	assert.deepEqual(s.tasks.find((t) => t.id === 2)!.blockedBy, [1]);
	assert.equal(s.nextId, 4);
});

test("createTask drops self/dangling/cycle blockers with warnings", () => {
	let s = seed();
	const result = createTask(s, "x", "", [99, 4], 10); // 4 = its own id
	assert.equal(result.task!.blockedBy.length, 0);
	assert.equal(result.warnings.length, 2);
	assert.ok(result.warnings.some((w) => w.includes("does not exist")));
	assert.ok(result.warnings.some((w) => w.includes("cannot block itself")));
});

test("cycle detection walks the chain", () => {
	let s = seed();
	// make #3 blocked by #2 → chain 3←2←1
	s = updateTask(s, 3, { blockedBy: [2] }, 5).state;
	assert.ok(wouldCycle(s, 1, 3)); // 1 blocked by 3 would cycle
	assert.ok(wouldCycle(s, 1, 2));
	assert.ok(!wouldCycle(s, 3, 1));
	const result = updateTask(s, 1, { blockedBy: [3] }, 6);
	assert.deepEqual(result.task!.blockedBy, []);
	assert.ok(result.warnings.some((w) => w.includes("cycle")));
});

test("dependency gate: blocked tasks refuse in_progress/completed", () => {
	const s = seed();
	const start = updateTask(s, 2, { status: "in_progress" }, 5);
	assert.ok(start.error?.includes("blocked by #1"));
	// unblocking by completing #1 (with evidence) releases #2
	let s2 = updateTask(s, 1, { status: "completed", evidence: "schema.sql reviewed" }, 6).state;
	const now = updateTask(s2, 2, { status: "in_progress" }, 7);
	assert.equal(now.error, null);
	assert.equal(now.task!.status, "in_progress");
});

test("evidence gate: completion without evidence refused", () => {
	const s = seed();
	const fail = updateTask(s, 3, { status: "completed" }, 5);
	assert.ok(fail.error?.includes("requires evidence"));
	const ok = updateTask(s, 3, { status: "completed", evidence: "docs render, links checked" }, 5);
	assert.equal(ok.error, null);
	assert.equal(ok.task!.status, "completed");
});

test("cancelled blockers no longer block", () => {
	let s = seed();
	s = updateTask(s, 1, { status: "cancelled" }, 5).state;
	const result = updateTask(s, 2, { status: "in_progress" }, 6);
	assert.equal(result.error, null);
});

test("readyTasks excludes blocked and non-pending", () => {
	let s = seed();
	assert.deepEqual(readyTasks(s).map((t) => t.id), [1, 3]);
	s = updateTask(s, 1, { status: "in_progress" }, 5).state;
	assert.deepEqual(readyTasks(s).map((t) => t.id), [3]);
});

test("updateTask on missing id errors", () => {
	assert.ok(updateTask(seed(), 42, { subject: "x" }, 1).error?.includes("no task #42"));
});

test("replayBranch: last snapshot wins, junk skipped", () => {
	const s = seed();
	const restored = replayBranch([
		{ type: "custom", customType: TASK_STATE, data: EMPTY_STATE },
		{ type: "custom", customType: TASK_STATE, data: { bogus: true } },
		{ type: "custom", customType: TASK_STATE, data: s },
	]);
	assert.equal(restored.tasks.length, 3);
	assert.equal(restored.nextId, 4);
	assert.deepEqual(replayBranch([]), { tasks: [], nextId: 1 });
});

test("nudge fires on stale open tasks and stuck in_progress", () => {
	const s = seed();
	assert.ok(!shouldNudge({ state: EMPTY_STATE, turnsSinceTaskTool: 99, lastTurnTextOnly: true }));
	assert.ok(!shouldNudge({ state: s, turnsSinceTaskTool: 2, lastTurnTextOnly: false }));
	assert.ok(shouldNudge({ state: s, turnsSinceTaskTool: 3, lastTurnTextOnly: false }));
	const stuck = updateTask(s, 1, { status: "in_progress" }, 5).state;
	assert.ok(shouldNudge({ state: stuck, turnsSinceTaskTool: 1, lastTurnTextOnly: true }));
	assert.ok(!shouldNudge({ state: stuck, turnsSinceTaskTool: 0, lastTurnTextOnly: true }));
});

test("nudge content lists open tasks with blockers, never completed ones", () => {
	let s = seed();
	s = updateTask(s, 1, { status: "completed", evidence: "done" }, 5).state;
	const nudge = buildNudge(s);
	assert.ok(nudge.startsWith("<system-reminder>"));
	assert.ok(nudge.includes('"blockedBy":[1]') === false); // #1 completed → not an open blocker
	assert.ok(nudge.includes("implement api"));
	assert.ok(!nudge.includes("design schema"));
});

test("widget renders statuses, blocked markers, and count", () => {
	let s = seed();
	s = updateTask(s, 1, { status: "in_progress" }, 5).state;
	const text = buildWidgetLines(s, theme).join("\n");
	assert.ok(text.includes("☑ tasks 0/3"));
	assert.ok(text.includes("✳ #1"));
	assert.ok(text.includes("⊘ #2 implement api (blocked by #1)"));
	assert.ok(text.includes("◻ #3 write docs"));
	assert.deepEqual(buildWidgetLines(EMPTY_STATE, theme), []);
});

test("v0.2 classifyTurn reads pi's toolCall name field", () => {
	const turn = (blocks: unknown[]) => [{ role: "assistant", content: blocks }];
	assert.deepEqual(classifyTurn(turn([{ type: "toolCall", name: "task_update" }])), {
		usedTaskTool: true,
		anyToolCall: true,
	});
	// the legacy shape still classifies
	assert.deepEqual(classifyTurn(turn([{ type: "toolCall", toolName: "task_list" }])), {
		usedTaskTool: true,
		anyToolCall: true,
	});
	assert.deepEqual(classifyTurn(turn([{ type: "toolCall", name: "bash" }])), {
		usedTaskTool: false,
		anyToolCall: true,
	});
	assert.deepEqual(classifyTurn(turn([{ type: "text", text: "hi" }])), {
		usedTaskTool: false,
		anyToolCall: false,
	});
	// user messages and junk never count
	assert.deepEqual(classifyTurn([{ role: "user", content: [{ type: "toolCall", name: "task_create" }] }, null]), {
		usedTaskTool: false,
		anyToolCall: false,
	});
	assert.deepEqual(classifyTurn([]), { usedTaskTool: false, anyToolCall: false });
});

test("v0.2 newlyReady reports what a completion unblocked", () => {
	let state = createTask(EMPTY_STATE, "build", "", [], 1).state;
	state = createTask(state, "test", "", [1], 2).state;
	state = createTask(state, "ship", "", [2], 3).state;
	assert.deepEqual(readyTasks(state).map((t) => t.id), [1]);

	const started = updateTask(state, 1, { status: "in_progress" }, 4);
	assert.deepEqual(newlyReady(state, started.state), []);
	const done = updateTask(started.state, 1, { status: "completed", evidence: "bun test 12/12" }, 5);
	assert.deepEqual(newlyReady(started.state, done.state).map((t) => t.id), [2]);
	// #3 is still blocked by #2
	assert.deepEqual(readyTasks(done.state).map((t) => t.id), [2]);
});

test("v0.2 replayBranch survives a malformed snapshot", () => {
	const state = replayBranch([
		{
			type: "custom",
			customType: TASK_STATE,
			data: {
				nextId: 2,
				tasks: [
					// older schema: no blockedBy/blocks/evidence, unknown status
					{ id: 1, subject: "legacy", status: "wat" },
					{ id: 7, subject: "kept", status: "completed", blockedBy: [1], blocks: "junk" },
					{ subject: "no id" },
					"garbage",
				],
			},
		},
	]);
	assert.equal(state.tasks.length, 2);
	assert.equal(state.tasks[0]!.status, "pending");
	assert.deepEqual(state.tasks[0]!.blockedBy, []);
	assert.deepEqual(state.tasks[0]!.blocks, [7]);
	assert.deepEqual(state.tasks[1]!.blocks, []);
	// nextId never collides with a restored id
	assert.equal(state.nextId, 8);
	// the restored blockedBy edge is intact and readable without throwing
	assert.deepEqual(openBlockers(state.tasks[1]!, new Map(state.tasks.map((t) => [t.id, t]))), [1]);
});

// ── nudge.test.ts (upstream) ─────────────────────────────────────────────

function task(id: number, status: "pending" | "in_progress" | "completed" | "cancelled") {
	return {
		id,
		subject: `task ${id}`,
		description: "",
		status,
		blockedBy: [] as number[],
		blocks: [] as number[],
		evidence: status === "completed" ? "checked" : null,
		createdAt: 0,
		updatedAt: 0,
	};
}

const state = (...tasks: ReturnType<typeof task>[]): TaskState => ({ tasks, nextId: tasks.length + 1 });
const done = (id: number) => task(id, "completed");

test("a finished list earns one sweep, and only one", () => {
	const finished = state(done(1), done(2));

	const signature = completionSignature(finished);
	assert.equal(signature, "1,2");
	// The same list on the next turn has the same signature, so the caller
	// knows not to send it again.
	assert.equal(completionSignature(finished), signature);

	// Cancelled items do not hold a list open, but an all-cancelled list is not
	// a completion worth checking.
	assert.equal(completionSignature(state(done(1), task(2, "cancelled"))), "1");
	assert.equal(completionSignature(state(task(1, "cancelled"))), null);
	assert.equal(completionSignature(state()), null);
	assert.equal(completionSignature(state(done(1), task(2, "pending"))), null);
	assert.equal(completionSignature(state(done(1), task(2, "in_progress"))), null);

	// Adding work reopens the list; finishing it again is a new completion.
	assert.notEqual(completionSignature(state(done(1), done(2), done(3))), signature);
});

test("the sweep checks the request against the result, not the list against itself", () => {
	const text = buildCompletionSweep(state(done(1), done(2)));
	assert.match(text, /All 2 tasks/);
	assert.match(text, /Re-read what the user actually asked for/);
	assert.match(text, /proves the plan was followed, not that the plan covered the request/);
	assert.match(text, /quietly narrowed/);
	// It is a reminder, not something to narrate.
	assert.match(text, /do not mention it to the user/);
	assert.match(buildCompletionSweep(state(done(1))), /All 1 task /);
});

// ── wiring tests against a fake pi API ───────────────────────────────────
// sse-probe lesson: event/tool contracts need shape-level pinning too.

interface FakeTool {
	name: string;
	parameters: unknown;
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

function fakePi() {
	const tools = new Map<string, FakeTool>();
	const entries: { customType: string; data: unknown }[] = [];
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown> | unknown>();
	const commands = new Map<string, { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }>();
	let branch: unknown[] = [];

	const pi = {
		registerTool: (t: FakeTool) => tools.set(t.name, t),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: (name: string, def: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) =>
			commands.set(name, def),
	};
	const ctx = {
		hasUI: false,
		sessionManager: {
			getBranch: () => branch,
			// "" by default: wiring tests must not write real status files;
			// the projection test flips this on explicitly.
			getSessionId: () => "",
		},
	};
	return {
		pi,
		ctx,
		entries,
		commands,
		handlers,
		tool: (name: string) => {
			const t = tools.get(name);
			if (!t) throw new Error(`tool ${name} not registered`);
			return t;
		},
		setBranch: (b: unknown[]) => {
			branch = b;
		},
	};
}

test("wiring: registers the three tools, the tasks command, and the lifecycle hooks", () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	for (const name of ["task_create", "task_update", "task_list"]) f.tool(name);
	assert.ok(f.commands.has("tasks"));
	for (const event of ["context", "agent_end", "session_start", "session_tree", "session_shutdown"]) {
		assert.ok(f.handlers.has(event), `missing handler for ${event}`);
	}
});

test("wiring: task_create commits a task-state ledger entry", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	const out = (await f.tool("task_create").execute("c1", { subject: "port task ext" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(out.content[0]!.text, /Created #1: port task ext/);
	assert.equal(f.entries.length, 1);
	assert.equal(f.entries[0]!.customType, TASK_STATE);
	const data = f.entries[0]!.data as { tasks: { id: number; subject: string }[] };
	assert.equal(data.tasks[0]!.subject, "port task ext");
});

test("wiring: evidence gate surfaces through task_update execute", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "a" }, undefined, undefined, f.ctx);
	await assert.rejects(
		f.tool("task_update").execute("u1", { id: 1, status: "completed" }, undefined, undefined, f.ctx),
		/requires evidence/,
	);
	await f.tool("task_update").execute("u2", { id: 1, status: "completed", evidence: "bun test green" }, undefined, undefined, f.ctx);
	const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(list.content[0]!.text, /completed · evidence recorded/);
});

test("wiring: context hook injects a transient reminder and returns messages", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "stale work" }, undefined, undefined, f.ctx);
	// simulate three agent_end turns without task tool use (text-only turns)
	for (let i = 0; i < 3; i++) {
		await f.handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "talk" }] }] });
	}
	const result = (await f.handlers.get("context")!({ messages: [{ role: "user", content: [] }] })) as {
		messages: { role: string; content: { type: string; text: string }[] }[];
	};
	assert.ok(result, "context handler returned undefined — no nudge injected");
	const injected = result.messages.at(-1)!;
	assert.equal(injected.role, "user");
	assert.match(injected.content[0]!.text, /<system-reminder>/);
	assert.match(injected.content[0]!.text, /stale work/);
	// transient: the original message stays first, nothing was persisted
	assert.equal(result.messages.length, 2);
	assert.equal(f.entries.length, 1);
});

test("wiring: session_start replays state from the session branch", async () => {
	const f = fakePi();
	// build state in a first instance, capture its ledger entry
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "survives restart" }, undefined, undefined, f.ctx);
	const entry = f.entries.at(-1)!;
	// fresh instance replays the branch containing that entry
	const f2 = fakePi();
	f2.setBranch([{ type: "custom", customType: TASK_STATE, data: entry.data }]);
	taskExtension(f2.pi as never);
	await f2.handlers.get("session_start")!({}, f2.ctx);
	const list = (await f2.tool("task_list").execute("l1", {}, undefined, undefined, f2.ctx)) as {
		content: { text: string }[];
	};
	assert.match(list.content[0]!.text, /survives restart/);
});

test("wiring: completion sweep fires exactly once per finished list", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "only task" }, undefined, undefined, f.ctx);
	await f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "verified output" }, undefined, undefined, f.ctx);
	const first = (await f.handlers.get("context")!({ messages: [] })) as { messages: unknown[] } | undefined;
	assert.ok(first, "first context after completion must inject the sweep");
	const second = (await f.handlers.get("context")!({ messages: [] })) as { messages: unknown[] } | undefined;
	assert.equal(second, undefined, "sweep must not fire twice for the same list");
});

// ── status-file projection (v1.4.21: ledger stays truth, file is audit) ──

describe("status-file projection", () => {
	test("taskStatusPath lands under ~/.pi/agent/task-status/<sessionId>.json", () => {
		const p = taskStatusPath("abc123");
		assert.ok(p.endsWith([".pi", "agent", "task-status", "abc123.json"].join("/")), `bad path: ${p}`);
	});

	test("buildTaskStatus: counts, ready set, reverse links, evidence passthrough", () => {
		let state = createTask(EMPTY_STATE, "first", "", [], 1).state;
		state = createTask(state, "second", "", [1], 2).state;
		state = updateTask(state, 1, { status: "completed", evidence: "bun test green" }, 3).state;
		const summary = buildTaskStatus(state, "sess-1", 12345);
		assert.equal(summary.v, 1);
		assert.equal(summary.sessionId, "sess-1");
		assert.equal(summary.total, 2);
		assert.equal(summary.byStatus.completed, 1);
		assert.equal(summary.byStatus.pending, 1);
		assert.deepEqual(summary.ready, [2], "blocker completed -> second becomes ready");
		assert.equal(summary.tasks[0]!.evidence, "bun test green");
		assert.deepEqual(summary.tasks[1]!.blockedBy, [1]);
		assert.deepEqual(summary.tasks[0]!.blocks, [2], "reverse link mirrored");
	});

	test("buildTaskStatus: cancelled blockers do not gate readiness", () => {
		let state = createTask(EMPTY_STATE, "gone", "", [], 1).state;
		state = createTask(state, "after", "", [1], 2).state;
		state = updateTask(state, 1, { status: "cancelled" }, 3).state;
		const summary = buildTaskStatus(state, "sess-2", 1);
		assert.deepEqual(summary.ready, [2]);
		assert.equal(summary.byStatus.cancelled, 1);
	});
});

test("wiring: task_create writes the status projection file", async () => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "task-status-"));
	const prevHome = process.env.HOME;
	process.env.HOME = tmp;
	try {
		const f = fakePi();
		(f.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "wire-test-session";
		taskExtension(f.pi as never);
		await f.handlers.get("session_start")!({}, f.ctx);
		await f.tool("task_create").execute("c1", { subject: "projection test" }, undefined, undefined, f.ctx);
		const file = join(tmp, ".pi", "agent", "task-status", "wire-test-session.json");
		type ParsedSummary = { sessionId: string; total: number; tasks: { subject: string }[] };
		let summary: ParsedSummary | null = null;
		for (let i = 0; i < 50 && !summary; i++) {
			try {
				const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ParsedSummary;
				// session_start writes an empty projection first; wait for the commit
				if (parsed && parsed.total === 1) summary = parsed;
			} catch {
				/* not there yet */
			}
			if (!summary) await new Promise((r) => setTimeout(r, 10));
		}
		assert.ok(summary, "projection file must appear after commit");
		assert.equal(summary.sessionId, "wire-test-session");
		assert.equal(summary.total, 1);
		assert.equal(summary.tasks[0]!.subject, "projection test");
	} finally {
		if (prevHome !== undefined) process.env.HOME = prevHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("wiring: projection failure never breaks the tool", async () => {
	const prevHome = process.env.HOME;
	process.env.HOME = "/proc/definitely-not-writable";
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.handlers.get("session_start")!({}, f.ctx);
		const out = (await f.tool("task_create").execute("c1", { subject: "still works" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /Created #1: still works/);
	} finally {
		if (prevHome !== undefined) process.env.HOME = prevHome;
	}
});

// ── v1.4.22: shutdown flush + stale-tmp sweep (observed live at daemon restart) ──

test("wiring: session_shutdown flushes the pending projection write", async () => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "task-flush-"));
	const prevHome = process.env.HOME;
	process.env.HOME = tmp;
	try {
		const f = fakePi();
		(f.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "flush-session";
		taskExtension(f.pi as never);
		await f.handlers.get("session_start")!({}, f.ctx);
		await f.tool("task_create").execute("c1", { subject: "flush me" }, undefined, undefined, f.ctx);
		// NO polling: the shutdown handler must await the queue itself
		await f.handlers.get("session_shutdown")!({}, f.ctx);
		const file = join(tmp, ".pi", "agent", "task-status", "flush-session.json");
		const summary = JSON.parse(fs.readFileSync(file, "utf8")) as { total: number };
		assert.equal(summary.total, 1, "shutdown must land the queued write before exit");
	} finally {
		if (prevHome !== undefined) process.env.HOME = prevHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("writeTaskStatus sweeps stale tmps of its own target", async () => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "task-sweep-"));
	try {
		const file = join(tmp, "s1.json");
		fs.mkdirSync(join(tmp, "sub"), { recursive: false });
		fs.writeFileSync(`${file}.tmp-deadbeef`, "orphan", "utf8");
		fs.writeFileSync(join(tmp, "other.json.tmp-keep"), "foreign orphan", "utf8"); // NOT ours — must survive
		const { writeTaskStatus } = await import("./src/status-file.ts");
		await writeTaskStatus(file, buildTaskStatus(EMPTY_STATE, "s1"));
		assert.ok(fs.existsSync(file), "target written");
		assert.ok(!fs.existsSync(`${file}.tmp-deadbeef`), "own stale tmp swept");
		assert.ok(fs.existsSync(join(tmp, "other.json.tmp-keep")), "foreign tmps untouched");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
