/**
 * Tests for the task extension port (pifydev/task @ 0.3.0).
 *
 * Two layers:
 * 1. Upstream pure-function tests, ported verbatim from test/task.test.ts +
 *    test/nudge.test.ts (node:test -> bun:test; node:assert kept as-is).
 * 2. Wiring tests against a fake pi API (lesson from the sse-probe v1.4.12
 *    regression: pure-function tests miss event/tool-shape contracts).
 */
import { reportFollowUpMissing } from "./index.ts";
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
import { applyControlAction } from "./src/control.ts";
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

test("v1.4.65 #64: a held task is still nudged — held by the judge means work still open", () => {
	const s0 = seed();
	const held = updateTask(s0, 1, { status: "held" }, 5).state;
	assert.ok(shouldNudge({ state: held, turnsSinceTaskTool: 3, lastTurnTextOnly: false }));
	assert.ok(shouldNudge({ state: held, turnsSinceTaskTool: 1, lastTurnTextOnly: true }));
});

test("nudge only fires when a task is in_progress — a pending-only board is the user's queue, not the model forgetting (v1.4.63 #61/#63)", () => {
	const s = seed();
	assert.ok(!shouldNudge({ state: EMPTY_STATE, turnsSinceTaskTool: 99, lastTurnTextOnly: true }));
	// pending-only: NEVER nudge, no matter how stale (user 00:5x — 14 pending
	// tasks awaiting the user once made the reminder fire almost every turn)
	assert.ok(!shouldNudge({ state: s, turnsSinceTaskTool: 99, lastTurnTextOnly: false }));
	assert.ok(!shouldNudge({ state: s, turnsSinceTaskTool: 99, lastTurnTextOnly: true }));
	const stuck = updateTask(s, 1, { status: "in_progress" }, 5).state;
	assert.ok(shouldNudge({ state: stuck, turnsSinceTaskTool: 1, lastTurnTextOnly: true }));
	assert.ok(shouldNudge({ state: stuck, turnsSinceTaskTool: 3, lastTurnTextOnly: false }));
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
	const messages: { content: string; customType?: string; display?: boolean; userRole?: boolean; details?: unknown }[] = [];
	const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<unknown> | unknown>();
	const commands = new Map<string, { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }>();
	let branch: unknown[] = [];

	const pi = {
		registerTool: (t: FakeTool) => tools.set(t.name, t),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: (name: string, def: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) =>
			commands.set(name, def),
		// #246: the wake loop emits through these — capture so tests can assert emits.
		sendMessage: (m: { content: string; customType?: string; display?: boolean; details?: unknown }) => messages.push({ ...m }),
		sendUserMessage: (text: string) => messages.push({ content: text, userRole: true }),
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
		messages,
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

test("v1.4.29 wiring: details.changes rides create/update as a compact diff", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	const created = (await f.tool("task_create").execute("c1", { subject: "diff card" }, undefined, undefined, f.ctx)) as {
		details?: { changes?: { id: number; subject: string; from: string | null; to: string }[] };
	};
	assert.deepEqual(created.details?.changes, [{ id: 1, subject: "diff card", from: null, to: "pending" }]);

	const updated = (await f.tool("task_update").execute("u1", { id: 1, status: "in_progress" }, undefined, undefined, f.ctx)) as {
		details?: { changes?: { id: number; from: string | null; to: string }[] };
	};
	assert.deepEqual(updated.details?.changes, [{ id: 1, subject: "diff card", from: "pending", to: "in_progress" }]);

	const listed = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as {
		details?: { changes?: unknown };
	};
	assert.equal(listed.details?.changes, undefined);
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
	// v1.4.63: nudge only when a task is in_progress — pending-only is the user's queue
	await f.tool("task_update").execute("c2", { id: 1, status: "in_progress" }, undefined, undefined, f.ctx);
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
	// (2 entries = task_create + task_update; the nudge itself writes nothing)
	assert.equal(result.messages.length, 2);
	assert.equal(f.entries.length, 2);
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
		assert.ok(p.endsWith(join(".pi", "agent", "task-status", "abc123.json")), `bad path: ${p}`);
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

test("wiring: tool results carry details.tasks snapshot for the Paseo transformer", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.handlers.get("session_start")!({}, f.ctx);
	await f.tool("task_create").execute("c1", { subject: "alpha" }, undefined, undefined, f.ctx);
	const created = await f.tool("task_create").execute("c2", { subject: "beta", blockedBy: [1] }, undefined, undefined, f.ctx);
	type Details = { tasks: { id: number; subject: string; status: string }[] };
	const createdDetails = (created as { details: Details }).details;
	assert.equal(createdDetails.tasks.length, 2, "create carries full snapshot");
	assert.equal(createdDetails.tasks[0]!.subject, "alpha");
	assert.equal(createdDetails.tasks[1]!.status, "pending");
	const updated = await f
		.tool("task_update")
		.execute("u1", { id: 1, status: "completed", evidence: "tests green" }, undefined, undefined, f.ctx);
	const updatedDetails = (updated as { details: Details }).details;
	assert.equal(updatedDetails.tasks[0]!.status, "completed", "update carries full snapshot");
	const listed = await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx);
	const listDetails = (listed as { details: Details }).details;
	assert.equal(listDetails.tasks.length, 2, "list carries full snapshot");
});

test("v1.4.64 (#64): an update that keeps status unchanged names WHAT changed — no more bare '#N → pending'", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.handlers.get("session_start")!({}, f.ctx);
	await f.tool("task_create").execute("c1", { subject: "gamma" }, undefined, undefined, f.ctx);
	// brief edit (description) — status stays pending
	const amended = (await f
		.tool("task_update")
		.execute("u1", { id: 1, description: "new brief" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	const txt = amended.content[0]!.text;
	assert.match(txt, /#1 → pending — status unchanged; changed: doneCheck/, "first line names the changed field");
	// a real status change has NO statusNote
	const moved = (await f
		.tool("task_update")
		.execute("u2", { id: 1, status: "in_progress" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(moved.content[0]!.text, /#1 → in_progress\n/);
	assert.ok(!moved.content[0]!.text.includes("status unchanged"));
});

// ── Verify layer 0+1 wiring (v1.4.24) ─────────────────────────────────

function fireBash(f: ReturnType<typeof fakePi>, id: string, cmd: string, output: string) {
	f.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "bash", args: { command: cmd } }, f.ctx);
	f.handlers.get("tool_execution_end")!(
		{ toolCallId: id, result: { content: [{ type: "text", text: output }] }, isError: false },
		f.ctx,
	);
}

test("verify wiring: create records the spec and reports the lane", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	const out = (await f
		.tool("task_create")
		.execute("c1", { subject: "bump pin", verify: { lane: "state", probes: [{ pattern: "gh pr view 139", expect: "MERGED" }], strict: true } }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(out.content[0]!.text, /Verify: lane=state, 1 probe, STRICT/);
	const data = f.entries.at(-1)!.data as { tasks: { verify: { lane: string; strict: boolean } }[] };
	assert.equal(data.tasks[0]!.verify.lane, "state");
	assert.equal(data.tasks[0]!.verify.strict, true);
});

test("verify wiring: red-green — an already-green probe is refused at create", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	fireBash(f, "t1", "gh pr view 139", "state MERGED");
	await assert.rejects(
		f.tool("task_create").execute("c1", { subject: "x", verify: { probes: [{ pattern: "gh pr view 139", expect: "MERGED" }] } }, undefined, undefined, f.ctx),
		/cannot discriminate/,
	);
});

test("verify wiring: completion is refused while a probe is red (never ran)", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "x", verify: { probes: [{ pattern: "bun test src/verify" }] } }, undefined, undefined, f.ctx);
	await assert.rejects(
		f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "tests passed" }, undefined, undefined, f.ctx),
		/NOT passed layer-1 verification/,
	);
	const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
	assert.match(list.content[0]!.text, /in_progress|pending/); // not completed
	assert.match(list.content[0]!.text, /verify:state\(1\)/);
});

test("verify wiring: non-bash tool calls never enter the run log", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "x", verify: { probes: [{ pattern: "bun test" }] } }, undefined, undefined, f.ctx);
	f.handlers
		.get("tool_execution_start")!({ toolCallId: "r1", toolName: "read", args: { command: "bun test" } }, f.ctx);
	f.handlers.get("tool_execution_end")!({ toolCallId: "r1", result: { content: [{ type: "text", text: "pass" }] } }, f.ctx);
	await assert.rejects(
		f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "ran it" }, undefined, undefined, f.ctx),
		/NOT passed layer-1 verification/,
	);
});

test("verify wiring: green path — real command in log unlocks completion + audit rides along", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f
		.tool("task_create")
		.execute("c1", { subject: "merge PR", verify: { probes: [{ pattern: "gh pr view 139", expect: "MERGED" }] } }, undefined, undefined, f.ctx);
	fireBash(f, "t1", "gh pr view 139 --json state", "…state: MERGED…");
	const out = (await f
		.tool("task_update")
		.execute("u1", { id: 1, status: "completed", evidence: "`gh pr view 139` shows MERGED" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(out.content[0]!.text, /Audit: ✓/);
	const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
	assert.match(list.content[0]!.text, /audit:pass/);
});

test("verify wiring: amber escalates to judge with observed output; amend fixes a wrong probe (cap 2)", async () => {
	const calls = stubJudge(JSON.stringify({ verdict: "insufficient_evidence", confidence: "low", reason: "not seen yet", cited_log_ids: [] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f
			.tool("task_create")
			.execute("c1", { subject: "check PR", verify: { probes: [{ pattern: "gh pr view 139", expect: "MERGED" }] } }, undefined, undefined, f.ctx);
		fireBash(f, "t1", "gh pr view 139", "state OPEN");
		// amber (ran, expect mismatched) → layer-2 rules; judge asks for more evidence → not complete yet
		const r1 = (await f
			.tool("task_update")
			.execute("u1", { id: 1, status: "completed", evidence: "PR state checked" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(r1.content[0]!.text, /not enough evidence/);
		// v1.4.65 #64: completion held → status HELD (no more ambiguous pending/in_progress)
		assert.match(r1.content[0]!.text, /#1 → held/);
		const lst = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(lst.content[0]!.text, /held · .*HELD judge 1\/3 — needs real evidence/);
		// #59: a held completion must expose itself — HELD note + judge round + NEXT
		assert.match(r1.content[0]!.text, /⏸ Completion HELD/);
		assert.match(r1.content[0]!.text, /judge round 1\/3/);
		assert.match(r1.content[0]!.text, /Do not re-declare verbatim/);
		assert.match(r1.content[0]!.text, /NEXT: \(1\) do what the gate actually requires/);
		assert.match(r1.content[0]!.text, /appeal=/);
		assert.equal(calls.length, 1);
		assert.match(calls[0]!, /\[amber\]/); // the real observed output rides the judge packet
		assert.match(calls[0]!, /OPEN/);

		// amend 1: probe was wrong (work is done, expect should be OPEN)
		await f
			.tool("task_update")
			.execute("u2", { id: 1, verify: { probes: [{ pattern: "gh pr view 139", expect: "OPEN" }] } }, undefined, undefined, f.ctx);
		// amend 2: still allowed
		await f.tool("task_update").execute("u3", { id: 1, verify: { probes: [{ pattern: "gh pr view 139", expect: "OPEN" }] } }, undefined, undefined, f.ctx);
		// amend 3: capped
		await assert.rejects(
			f.tool("task_update").execute("u4", { id: 1, verify: { probes: [{ pattern: "gh pr view 139", expect: "OPEN" }] } }, undefined, undefined, f.ctx),
			/already amended 2 times/,
		);
		const done = (await f
			.tool("task_update")
			.execute("u5", { id: 1, status: "completed", evidence: "PR OPEN as expected" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(done.content[0]!.text, /→ completed/);
		const data = f.entries.at(-1)!.data as { tasks: { verifyAmendments?: number }[] };
		assert.equal(data.tasks[0]!.verifyAmendments, 2);
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("verify wiring: judgment lane completes via the judge; advisory claims ride the packet", async () => {
	const calls = stubJudge(JSON.stringify({ verdict: "pass", confidence: "high", reason: "brief meets the done-check", cited_log_ids: [] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		const out = (await f
			.tool("task_update")
			.execute("u1", { id: 1, status: "completed", evidence: "wrote it, ran `grep -c source brief.md`" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /judge: PASS/);
		const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
		assert.match(list.content[0]!.text, /audit:judge-pass/);
		assert.match(calls[0]!, /grep -c source brief.md/); // backticked claim rides the judge packet
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("verify wiring: session_start clears the run log (restart = fresh evidence)", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "A", verify: { probes: [{ pattern: "bun test", expect: "pass" }] } }, undefined, undefined, f.ctx);
	await f.tool("task_create").execute("c2", { subject: "B", verify: { probes: [{ pattern: "bun test", expect: "pass" }] } }, undefined, undefined, f.ctx);
	fireBash(f, "t1", "bun test", "388 pass 0 fail");
	await f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "tests green" }, undefined, undefined, f.ctx);
	// simulate a restart: replay ledger state, run log resets
	f.setBranch(f.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })));
	await f.handlers.get("session_start")!({}, f.ctx);
	await assert.rejects(
		f.tool("task_update").execute("u2", { id: 2, status: "completed", evidence: "same suite" }, undefined, undefined, f.ctx),
		/NOT passed layer-1 verification/,
	);
	fireBash(f, "t2", "bun test", "388 pass 0 fail");
	await f.tool("task_update").execute("u3", { id: 2, status: "completed", evidence: "tests green again" }, undefined, undefined, f.ctx);
});

test("verify wiring: projection carries verify/audit fields for the Paseo panel", async () => {
	stubJudge(JSON.stringify({ verdict: "pass", confidence: "high", reason: "ok", cited_log_ids: [] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "x", verify: { probes: [{ pattern: "bun test", expect: "pass" }], strict: true } }, undefined, undefined, f.ctx);
		fireBash(f, "t1", "bun test", "all pass");
		await f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "suite green" }, undefined, undefined, f.ctx);
		const data = f.entries.at(-1)!.data as TaskState;
		const status = buildTaskStatus(data, "sess-verify");
		assert.equal(status.tasks[0]!.verify!.lane, "state");
		assert.equal(status.tasks[0]!.verify!.strict, true);
		assert.equal(status.tasks[0]!.verify!.probes, 1);
		assert.equal(status.tasks[0]!.audit!.verdict, "judge-pass"); // strict forces layer-2
		assert.match(status.tasks[0]!.audit!.summary, /judge: PASS/);
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

// ── Verify layer 2 wiring (v1.4.26) — judge stub via _setJudgeRunnerForTests ──

import { _setJudgeRunnerForTests } from "./index.ts";
import { MAX_JUDGE_ROUNDS } from "./src/judge.ts";

function stubJudge(reply: string | null) {
	const calls: string[] = [];
	_setJudgeRunnerForTests(async (packet: string) => {
		calls.push(packet);
		return reply;
	});
	return calls;
}

function failJson(v: Partial<{ verdict: string; confidence: string; reason: string }> = {}): string {
	return JSON.stringify({ verdict: "fail", confidence: "high", reason: "not done", cited_log_ids: [], ...v });
}

test("layer2 wiring: judgment-lane completion goes through the judge (pass → completed)", async () => {
	const calls = stubJudge(JSON.stringify({ verdict: "pass", confidence: "high", reason: "log supports it", cited_log_ids: [] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		const out = (await f
			.tool("task_update")
			.execute("u1", { id: 1, status: "completed", evidence: "8-sentence brief, sources cited" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /completed/);
		assert.match(out.content[0]!.text, /judge: PASS/);
		assert.equal(calls.length, 1);
		assert.match(calls[0]!, /done-check/); // packet shape rode through
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: fail-closed — judge unavailable refuses completion, no round spent", async () => {
	stubJudge(null);
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		await assert.rejects(
			f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "done" }, undefined, undefined, f.ctx),
			/fail-closed/,
		);
		const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
		assert.match(list.content[0]!.text, /pending/); // not in_progress, no judge-rounds yet
		assert.doesNotMatch(list.content[0]!.text, /judge-rounds/);
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: 2 consecutive high-conf fails demote to in_progress with reason", async () => {
	stubJudge(failJson());
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		// round 1: high-conf fail → refused (fail-streak 1), no demote yet
		const r1 = (await f
			.tool("task_update")
			.execute("u1", { id: 1, status: "completed", evidence: "draft" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(r1.content[0]!.text, /1\/2/);
		assert.match(r1.content[0]!.text, /pending/);
		// round 2: another high-conf fail → demote to in_progress, streak reset
		const r2 = (await f
			.tool("task_update")
			.execute("u2", { id: 1, status: "completed", evidence: "draft v2" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(r2.content[0]!.text, /in_progress/);
		assert.match(r2.content[0]!.text, /demote/);
		const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
		assert.doesNotMatch(list.content[0]!.text, /fail-streak/); // reset sau demote
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: low-conf fail asks for evidence without demotion", async () => {
	stubJudge(failJson({ confidence: "low" }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		const out = (await f
			.tool("task_update")
			.execute("u1", { id: 1, status: "completed", evidence: "draft" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /no demotion/);
		assert.match(out.content[0]!.text, /pending/);
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: amber state-lane escalates to judge; judge pass overrides the probe", async () => {
	const calls = stubJudge(JSON.stringify({ verdict: "pass", confidence: "medium", reason: "probe spec wrong — the work is done", cited_log_ids: [0] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f
			.tool("task_create")
			.execute("c1", { subject: "bump", verify: { lane: "state", probes: [{ pattern: "cat out.txt", expect: "V1" }] } }, undefined, undefined, f.ctx);
		fireBash(f, "t1", "cat out.txt", "V2"); // ran but expect mismatched → amber
		const out = (await f
			.tool("task_update")
			.execute("u1", { id: 1, status: "completed", evidence: "output V2" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /completed/);
		assert.match(out.content[0]!.text, /judge: PASS/);
		assert.equal(calls.length, 1);
		assert.match(calls[0]!, /\[amber\]/); // the packet carries the amber probe result
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: red state-lane still refuses WITHOUT calling the judge", async () => {
	const calls = stubJudge(JSON.stringify({ verdict: "pass", confidence: "high", reason: "?", cited_log_ids: [] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f
			.tool("task_create")
			.execute("c1", { subject: "bump", verify: { lane: "state", probes: [{ pattern: "cat out.txt", expect: "V1" }] } }, undefined, undefined, f.ctx);
		await assert.rejects(
			f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "done" }, undefined, undefined, f.ctx),
			/NOT passed layer-1 verification/,
		);
		assert.equal(calls.length, 0); // worker-fault: the judge costs nothing
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: strict forces the judge even when layer-1 is all green", async () => {
	const calls = stubJudge(JSON.stringify({ verdict: "pass", confidence: "high", reason: "ok", cited_log_ids: [0] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f
			.tool("task_create")
			.execute("c1", { subject: "bump", verify: { lane: "state", probes: [{ pattern: "cat out.txt", expect: "V1" }], strict: true } }, undefined, undefined, f.ctx);
		fireBash(f, "t1", "cat out.txt", "V1");
		const out = (await f
			.tool("task_update")
			.execute("u1", { id: 1, status: "completed", evidence: "green" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /judge: PASS/);
		assert.equal(calls.length, 1);
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: appeal parks the task with the reason — no judge call", async () => {
	const calls = stubJudge(JSON.stringify({ verdict: "pass", confidence: "high", reason: "?", cited_log_ids: [] }));
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		const out = (await f
			.tool("task_update")
			.execute("u1", { id: 1, appeal: "judge ruled wrong — the real output met the done-check" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /parked/);
		assert.match(out.content[0]!.text, /PARKED/);
		assert.equal(calls.length, 0);
		const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
		assert.match(list.content[0]!.text, /judge ruled wrong/);
		// the model cannot un-park it (v1.4.28 one-way park)
		await assert.rejects(
			f.tool("task_update").execute("u2", { id: 1, status: "in_progress" }, undefined, undefined, f.ctx),
			/cannot un-park/,
		);
		// reopening only via the user surface (control bridge)
		const back = applyControlAction(
			((f.entries.at(-1) as { data: unknown }).data as TaskState),
			{ v: 1, action: "unpark", id: 1 },
			Date.now(),
		);
		assert.equal(back.state.tasks[0]!.status, "in_progress");
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: 3rd round refusal parks instead of judging a 4th time", async () => {
	stubJudge(failJson({ confidence: "low" })); // every round is need-evidence
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		for (let i = 0; i < MAX_JUDGE_ROUNDS - 1; i++) {
			await f.tool("task_update").execute(`u${i}`, { id: 1, status: "completed", evidence: `draft ${i}` }, undefined, undefined, f.ctx);
		}
		const out = (await f
			.tool("task_update")
			.execute("u3", { id: 1, status: "completed", evidence: "draft 3" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		assert.match(out.content[0]!.text, /parked/);
		const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
		assert.match(list.content[0]!.text, /judge-rounds:3/);
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

test("layer2 wiring: projection carries failStreak/judgeRounds/appealReason + parked status", async () => {
	stubJudge(failJson());
	try {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "write brief", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
		await f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "d" }, undefined, undefined, f.ctx);
		await f.tool("task_update").execute("u2", { id: 1, appeal: "disagree with the verdict" }, undefined, undefined, f.ctx);
		const status = buildTaskStatus(f.entries.at(-1)!.data as TaskState, "");
		assert.equal(status.tasks[0]!.status, "parked");
		assert.equal(status.tasks[0]!.failStreak, 0);
		assert.equal(status.tasks[0]!.judgeRounds, 1);
		assert.match(status.tasks[0]!.appealReason!, /disagree with/);
	} finally {
		_setJudgeRunnerForTests(null);
	}
});

// ── Control bridge wiring (v1.4.28): one-way PARK + strict v2 ──────────

test("control wiring: model cannot un-park a parked task via task_update", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "disputed work", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
	await f.tool("task_update").execute("u1", { id: 1, appeal: "judge ruled wrong" }, undefined, undefined, f.ctx);
	// the model reopens it itself → refused
	await assert.rejects(
		f.tool("task_update").execute("u2", { id: 1, status: "in_progress" }, undefined, undefined, f.ctx),
		/cannot un-park/,
	);
	// the model cancels a task awaiting the user → also blocked (cancelling = hiding the dispute)
	await assert.rejects(
		f.tool("task_update").execute("u3", { id: 1, status: "cancelled" }, undefined, undefined, f.ctx),
		/cannot un-park/,
	);
	// re-park (already parked) is still harmless — allowed through
	const re = (await f.tool("task_update").execute("u4", { id: 1, status: "parked" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(re.content[0]!.text, /parked/);
});

test("control wiring: amendment cannot lower strict; raising still allowed", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f
		.tool("task_create")
		.execute("c1", { subject: "x", verify: { probes: [{ pattern: "cat a", expect: "A" }], strict: true } }, undefined, undefined, f.ctx);
	fireBash(f, "t1", "cat a", "A");
	// amend deliberately drops strict → forced back to true
	const out = (await f
		.tool("task_update")
		.execute("u1", { id: 1, verify: { probes: [{ pattern: "cat a", expect: "A" }] } }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	const data = f.entries.at(-1)!.data as TaskState;
	assert.equal(data.tasks[0]!.verify!.strict, true); // not lowered
	// raising strict on a non-strict task → allowed
	await f.tool("task_create").execute("c2", { subject: "y", verify: { probes: [{ pattern: "cat b", expect: "B" }] } }, undefined, undefined, f.ctx);
	await f.tool("task_update").execute("u2", { id: 2, verify: { probes: [{ pattern: "cat b", expect: "B" }], strict: true } }, undefined, undefined, f.ctx);
	const data2 = f.entries.at(-1)!.data as TaskState;
	assert.equal(data2.tasks[1]!.verify!.strict, true);
	assert.ok(out, "amend accepted");
});

test("control wiring: consumeControlFile applies unpark + strict from the user surface", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	// session_start with an empty sessionId → empty controlSessionId; but consuming
	// via the handler is still testable by setting a temporary HOME + a real sessionId.
	// Apply logic is already covered by the pure applyControlAction tests; the wiring
	// that matters: session_start registers the watcher + replay keeps the parked state.
	await f.tool("task_create").execute("c1", { subject: "s", verify: { lane: "judgment" } }, undefined, undefined, f.ctx);
	await f.tool("task_update").execute("u1", { id: 1, appeal: "test" }, undefined, undefined, f.ctx);
	// restart replay: parked survives via the ledger
	f.setBranch(f.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })));
	await f.handlers.get("session_start")!({}, f.ctx);
	const list = (await f.tool("task_list").execute("l1", {}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
	assert.match(list.content[0]!.text, /parked/); // replay keeps parked
});

// ── v1.4.38 wiring: doneCheck guard — the agent may amend the brief but not swap it out ──
describe("v1.4.38 wiring: doneCheck amendment gates", () => {
	async function amendTwiceAndFailThird() {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "deploy" }, undefined, undefined, f.ctx);
		const third: string[] = [];
		// attempts 1 + 2: allowed
		for (const desc of ["agent brief v1", "agent brief v2"]) {
			const out = (await f.tool("task_update").execute("u", { id: 1, description: desc }, undefined, undefined, f.ctx)) as {
				content: { text: string }[];
			};
			assert.match(out.content[0]!.text, /#1 → /);
		}
		// attempt 3 (v1.4.53): no more throwing — records a proposal awaiting user approval
		const out3 = (await f.tool("task_update").execute("u3", { id: 1, description: "running echo ok means done", amendReason: "narrower scope" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		third.push(out3.content[0]!.text);
		return third;
	}

	test("agent rewrite #1 and #2 pass, #3 → PROPOSAL awaiting user (no throw, v1.4.53)", async () => {
		const third = await amendTwiceAndFailThird();
		assert.equal(third.length, 1);
		assert.match(third[0]!, /recorded proposal p\w+/);
		assert.match(third[0]!, /NOT changed/);
	});

	test("state after two agent rewrites carries descAmendments + trail", async () => {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "deploy" }, undefined, undefined, f.ctx);
		await f.tool("task_update").execute("u1", { id: 1, description: "v1" }, undefined, undefined, f.ctx);
		await f.tool("task_update").execute("u2", { id: 1, description: "v2" }, undefined, undefined, f.ctx);
		const data = f.entries[f.entries.length - 1]!.data as {
			tasks: { descAmendments?: number; descHistory?: { by: string; from: string; to: string }[] }[];
		};
		assert.equal(data.tasks[0]!.descAmendments, 2);
		assert.equal(data.tasks[0]!.descHistory?.length, 2);
		assert.equal(data.tasks[0]!.descHistory?.[1]?.from, "v1");
		assert.equal(data.tasks[0]!.descHistory?.[1]?.to, "v2");
	});

	test("identical description rewrite is free (no false amend)", async () => {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute("c1", { subject: "s", description: "same text" }, undefined, undefined, f.ctx);
		await f.tool("task_update").execute("u1", { id: 1, description: " same text " }, undefined, undefined, f.ctx);
		const data = f.entries[f.entries.length - 1]!.data as { tasks: { descAmendments?: number }[] };
		assert.equal(data.tasks[0]!.descAmendments, undefined);
	});

	test("strict task: agent cannot rewrite the doneCheck at all", async () => {
		const f = fakePi();
		taskExtension(f.pi as never);
		await f.tool("task_create").execute(
			"c1",
			{ subject: "s", verify: { lane: "state", probes: [], strict: true } },
			undefined,
			undefined,
			f.ctx,
		);
		const out = (await f.tool("task_update").execute("u1", { id: 1, description: "new brief" }, undefined, undefined, f.ctx)) as {
			content: { text: string }[];
		};
		// v1.4.53: strict tasks can still PROPOSE (a proposal = asking the user), just not self-edit
		assert.match(out.content[0]!.text, /recorded proposal p\w+/);
		assert.match(out.content[0]!.text, /strict/);
	});
});

// ── v1.4.76: write/edit tool calls enter the run log ─────────────────────
// 2026-09-15 incident bug D: files created via the write tool were invisible
// to layer-1 probes and the judge — #68 held twice on "no command shows file
// creation". Now write/edit are recorded like bash calls and probe-matchable.

test("v1.4.76 wiring: write/edit enter runLog and satisfy layer-1 probes", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	const created = (await f.tool("task_create").execute("c1", {
		subject: "create files",
		verify: {
			lane: "state",
			probes: [{ pattern: "write extensions/lessons/index.ts" }, { pattern: "edit extensions/task/index.ts" }],
		},
	}, undefined, undefined, f.ctx)) as { content: { text: string }[] };
	assert.match(created.content[0]!.text, /Created #1/);
	await f.tool("task_update").execute("u1", { id: 1, status: "in_progress" }, undefined, undefined, f.ctx);
	f.handlers.get("tool_execution_start")!({
		toolCallId: "w1",
		toolName: "write",
		args: { path: "extensions/lessons/index.ts", content: "export default 1;\n" },
	});
	f.handlers.get("tool_execution_end")!({ toolCallId: "w1", result: { content: [{ type: "text", text: "wrote file" }] } });
	f.handlers.get("tool_execution_start")!({
		toolCallId: "e1",
		toolName: "edit",
		args: { path: "extensions/task/index.ts", edits: [{ oldText: "a", newText: "b" }] },
	});
	f.handlers.get("tool_execution_end")!({ toolCallId: "e1", result: { content: [{ type: "text", text: "edited file" }] } });
	const out = (await f.tool("task_update").execute("u2", { id: 1, status: "completed", evidence: "files written via write/edit tools" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(out.content[0]!.text, /completed/i);
	assert.doesNotMatch(out.content[0]!.text, /NOT passed layer-1|held/i);
});

test("v1.4.87 decision pair: awaitsDecision creates an [AWAITING-USER-DECISION] stage blocked by A", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	const out = (await f.tool("task_create").execute(
		"c1",
		{ subject: "eval ext X", awaitsDecision: true },
		undefined,
		undefined,
		f.ctx,
	)) as { content: { text: string }[]; details?: { tasks?: { id: number; subject: string; status: string; blockedBy: number[]; description: string; verify?: { lane: string } }[] } };
	assert.match(out.content[0]!.text, /Created #1: eval ext X/);
	assert.match(out.content[0]!.text, /Decision pair: #2 \[AWAITING-USER-DECISION\] created blocked by #1/);
	const tasks = out.details!.tasks!;
	assert.equal(tasks.length, 2);
	const b = tasks.find((t) => t.id === 2)!;
	assert.equal(b.subject, "[AWAITING-USER-DECISION] eval ext X (#1)");
	assert.equal(b.status, "pending");
	// full fields (blockedBy/description/verify) live in the ledger state, not the slim details projection
	const ledger = f.entries.at(-1)!.data as { tasks: { id: number; blockedBy: number[]; description: string; verify?: { lane: string } }[] };
	const lb = ledger.tasks.find((t) => t.id === 2)!;
	assert.deepEqual(lb.blockedBy, [1]);
	assert.match(lb.description, /^decisionOf:#1\n/);
	assert.equal(lb.verify?.lane, "judgment");
});

test("v1.4.87 decision pair: without awaitsDecision nothing extra is created (no regression)", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	const out = (await f.tool("task_create").execute("c1", { subject: "plain task" }, undefined, undefined, f.ctx)) as {
		details?: { tasks?: unknown[] };
	};
	assert.equal(out.details!.tasks!.length, 1);
});

test("v1.4.88 hardening: model cancels A → pending B is PARKED (not cancelled) — P1/P3 closed", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "eval ext Y", awaitsDecision: true }, undefined, undefined, f.ctx);
	const cancelled = (await f.tool("task_update").execute("c2", { id: 1, status: "cancelled" }, undefined, undefined, f.ctx)) as {
		details?: { tasks?: { id: number; status: string }[] };
	};
	const statuses = Object.fromEntries((cancelled.details!.tasks ?? []).map((t) => [t.id, t.status]));
	assert.equal(statuses[1], "cancelled");
	assert.equal(statuses[2], "parked", "B must survive as parked — never silently erased");
});

test("v1.4.88 hardening: model cannot cancel B directly — P2 closed (user-owned existence)", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "eval ext Z", awaitsDecision: true }, undefined, undefined, f.ctx);
	await assert.rejects(
		f.tool("task_update").execute("c2", { id: 2, status: "cancelled" }, undefined, undefined, f.ctx),
		/AWAITING-USER-DECISION.*user-owned.*cancel \(user\)/s,
	);
});

test("v1.4.88 hardening: typed decisionOf survives description edits (marker strip closed)", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "eval ext W", awaitsDecision: true }, undefined, undefined, f.ctx);
	await f.tool("task_update").execute("c2", { id: 2, description: "marker stripped, no decisionOf line" }, undefined, undefined, f.ctx);
	const ledger = f.entries.at(-1)!.data as { tasks: { id: number; description: string; decisionOf?: number }[] };
	const b = ledger.tasks.find((x) => x.id === 2)!;
	assert.equal(b.decisionOf, 1, "typed field intact after description rewrite");
	assert.equal(b.description, "marker stripped, no decisionOf line");
	// guard still fires on the typed field even though the description marker is gone
	await assert.rejects(
		f.tool("task_update").execute("c3", { id: 2, status: "cancelled" }, undefined, undefined, f.ctx),
		/user-owned/,
	);
});

test("v1.4.88 control: user cancel action genuinely cancels, with genuine pair cascade", () => {
	const s0 = createTask(EMPTY_STATE, "A", "", [], 1).state!;
	const s1 = createTask(s0, "B", "", [1], 2, { lane: "judgment", probes: [], strict: false }, undefined, undefined, undefined, 1).state!;
	const r = applyControlAction(s1, { v: 1, action: "cancel", id: 1 }, 3);
	assert.ok(r.applied);
	const statuses = Object.fromEntries(r.state.tasks.map((t) => [t.id, t.status]));
	assert.equal(statuses[1], "cancelled");
	assert.equal(statuses[2], "cancelled", "user-origin cancel may genuinely drop the pair");
});

describe("reportFollowUpMissing — REPORT FOLLOW-UP rule (2026-09-22)", () => {
	const mk = (tasks: Array<{ id: number; subject: string; description?: string; blockedBy?: number[] }>) => ({ tasks });

	test("report-type task with no references → nudge", () => {
		assert.equal(reportFollowUpMissing(mk([{ id: 1, subject: "Evaluate Redis vs KeyDB" }]), { id: 1, subject: "Evaluate Redis vs KeyDB" }), true);
		assert.equal(reportFollowUpMissing(mk([{ id: 2, subject: "Nghiên cứu NAS chassis" }]), { id: 2, subject: "Nghiên cứu NAS chassis" }), true);
	});

	test("successor via blockedBy or '#id' mention → no nudge", () => {
		const board = [
			{ id: 1, subject: "Audit #46-style env scan" },
			{ id: 2, subject: "Fix symlink", description: "from audit #46 F1", blockedBy: [1] },
		];
		assert.equal(reportFollowUpMissing(mk(board), board[0]), false);
		const board2 = [
			{ id: 1, subject: "Research doorbell latency" },
			{ id: 9, subject: "Implement doorbell", description: "follow-up #1" },
		];
		assert.equal(reportFollowUpMissing(mk(board2), board2[0]), false);
	});

	test("non-report task → never nudged", () => {
		assert.equal(reportFollowUpMissing(mk([{ id: 3, subject: "Ship v1.4.125 tag" }]), { id: 3, subject: "Ship v1.4.125 tag" }), false);
	});
});

test("v1.4.125 wiring: completing an orphan REPORT task surfaces the FOLLOW-UP NUDGE", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "Evaluate orphan report" }, undefined, undefined, f.ctx);
	const out = (await f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "report written" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.match(out.content[0]!.text, /FOLLOW-UP NEEDED: #1 delivers a REPORT/);
});

test("v1.4.125 wiring: report task WITH successor blockedBy → no nudge", async () => {
	const f = fakePi();
	taskExtension(f.pi as never);
	await f.tool("task_create").execute("c1", { subject: "Audit with successor" }, undefined, undefined, f.ctx);
	await f.tool("task_create").execute("c2", { subject: "Implement findings", blockedBy: [1] }, undefined, undefined, f.ctx);
	const out = (await f.tool("task_update").execute("u1", { id: 1, status: "completed", evidence: "report written" }, undefined, undefined, f.ctx)) as {
		content: { text: string }[];
	};
	assert.doesNotMatch(out.content[0]!.text, /FOLLOW-UP NEEDED/);
});

// ── #246 wake sanitize: the ledger never outlives the task state it tracks ──

import { _driveTaskWakeForTests } from "./index.ts";

interface WakeSeededTask {
	id: number;
	subject: string;
	status: "in_progress" | "completed" | "pending" | "cancelled";
}

function seedWakeBoard(tasks: WakeSeededTask[], wake?: { rounds: number; noProgress: number; signature: string }) {
	return {
		type: "custom" as const,
		customType: TASK_STATE,
		data: {
			tasks: tasks.map((t) => ({ ...t, createdAt: 1, updatedAt: 2 })),
			nextId: tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1,
			...(wake ? { wake } : {}),
		},
	};
}

test("#246 M1: plan owning the cadence still sanitizes the wake ledger at settle", async () => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "task-wake-"));
	const prevHome = process.env.HOME;
	process.env.HOME = tmp;
	try {
		const f = fakePi();
		(f.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "wake-m1";
		taskExtension(f.pi as never);
		// plan #100-style: tracking with steps left → higher kind owns the cadence
		fs.mkdirSync(join(tmp, ".pi", "agent", "plan-control"), { recursive: true });
		fs.writeFileSync(join(tmp, ".pi", "agent", "plan-control", "wake-m1.status.json"), JSON.stringify({ mode: "tracking", planId: "p-test", stepsDone: 1, stepsTotal: 3 }));
		// #174 completed while the plan was tracking; stale wake ledger persisted (the 2026-09-21 #174 incident shape)
		f.setBranch([seedWakeBoard([{ id: 174, subject: "done under plan", status: "completed" }], { rounds: 4, noProgress: 0, signature: "174:in_progress:1790004934598" })]);
		await f.handlers.get("session_start")!({}, f.ctx);
		_driveTaskWakeForTests("settle");
		const last = f.entries[f.entries.length - 1]!;
		assert.equal(last.customType, TASK_STATE, "sanitize must persist the cleaned state");
		assert.equal((last.data as { wake?: unknown }).wake, undefined, "stale wake ledger must be cleared even while a plan owns the wake cadence");
		assert.equal(f.messages.filter((m) => m.content.includes("[task wake")).length, 0, "no wake may fire for a completed task");
	} finally {
		if (prevHome !== undefined) process.env.HOME = prevHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("#246 M2: completing the last in_progress task clears the wake ledger in the same commit", async () => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "task-wake-"));
	const prevHome = process.env.HOME;
	process.env.HOME = tmp;
	stubJudge(JSON.stringify({ verdict: "pass", confidence: "high", reason: "brief meets the done-check", cited_log_ids: [] }));
	try {
		const f = fakePi();
		(f.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "wake-m2";
		taskExtension(f.pi as never);
		// plan tracking active: without M2 the commit would leave the wake ledger behind
		fs.mkdirSync(join(tmp, ".pi", "agent", "plan-control"), { recursive: true });
		fs.writeFileSync(join(tmp, ".pi", "agent", "plan-control", "wake-m2.status.json"), JSON.stringify({ mode: "tracking", planId: "p-test", stepsDone: 1, stepsTotal: 3 }));
		f.setBranch([seedWakeBoard([{ id: 174, subject: "finish me", status: "in_progress" }], { rounds: 2, noProgress: 0, signature: "174:in_progress:1" })]);
		await f.handlers.get("session_start")!({}, f.ctx);
		await f.tool("task_update").execute("u1", { id: 174, status: "completed", evidence: "suite green" }, undefined, undefined, f.ctx);
		const last = f.entries[f.entries.length - 1]!;
		assert.equal(last.customType, TASK_STATE);
		const data = last.data as { wake?: unknown; tasks?: { id: number; status: string }[] };
		assert.equal(data.wake, undefined, "the completion commit itself must clear the wake ledger (no window for a stale fire)");
		assert.equal(data.tasks!.find((t) => t.id === 174)!.status, "completed");
	} finally {
		_setJudgeRunnerForTests(null);
		if (prevHome !== undefined) process.env.HOME = prevHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("#246 M3: fire-time drops a stale signature id and starts the new open set fresh", async () => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "task-wake-"));
	const prevHome = process.env.HOME;
	process.env.HOME = tmp;
	try {
		const f = fakePi();
		(f.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "wake-m3";
		taskExtension(f.pi as never);
		f.setBranch([
			seedWakeBoard(
				[
					{ id: 174, subject: "done", status: "completed" },
					{ id: 180, subject: "live", status: "in_progress" },
				],
				{ rounds: 4, noProgress: 2, signature: "174:in_progress:1790004934598" },
			),
		]);
		await f.handlers.get("session_start")!({}, f.ctx);
		_driveTaskWakeForTests("fire");
		const last = f.entries[f.entries.length - 1]!;
		const wake = (last.data as { wake?: { rounds: number; signature: string } }).wake!;
		assert.equal(wake.rounds, 1, "the new open set starts at round 1, not inheriting the dead set's 4");
		assert.ok(wake.signature.startsWith("180:in_progress"), `signature rebuilt from the live open set: ${wake.signature}`);
		const emit = f.messages.find((m) => m.content.includes("[task wake"));
		assert.ok(emit, "wake must emit for the live set");
		assert.match(emit!.content, /#180/);
		assert.doesNotMatch(emit!.content, /#174/);
		assert.equal(emit!.customType, "task-wake");
	} finally {
		if (prevHome !== undefined) process.env.HOME = prevHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("#246 regression: normal wake still fires for a live in_progress task", async () => {
	const tmp = fs.mkdtempSync(join(tmpdir(), "task-wake-"));
	const prevHome = process.env.HOME;
	process.env.HOME = tmp;
	try {
		const f = fakePi();
		(f.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "wake-reg";
		taskExtension(f.pi as never);
		f.setBranch([seedWakeBoard([{ id: 190, subject: "still working", status: "in_progress" }])]);
		await f.handlers.get("session_start")!({}, f.ctx);
		_driveTaskWakeForTests("settle"); // decides + schedules (timer cleared by the next seam call)
		_driveTaskWakeForTests("fire"); // clears the pending timer, runs the emit half
		const last = f.entries[f.entries.length - 1]!;
		const wake = (last.data as { wake?: { rounds: number } }).wake!;
		assert.equal(wake.rounds, 1);
		const emit = f.messages.find((m) => m.content.includes("[task wake"));
		assert.ok(emit, "normal wake must still emit");
		assert.match(emit!.content, /\[task wake 1\/10\] #190/);
		assert.equal(emit!.customType, "task-wake");
		assert.notEqual(emit!.display, true, "wake stays a display:false custom entry (v1.4.86 contract)");
	} finally {
		if (prevHome !== undefined) process.env.HOME = prevHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
