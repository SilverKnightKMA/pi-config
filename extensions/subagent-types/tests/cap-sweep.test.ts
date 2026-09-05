/**
 * Concurrency cap + orphan sweep (2026-09-05, user-approved).
 * The daemon imposes no concurrent-agent limit, so a looping model could
 * spawn dozens of children; and children whose parent was killed (not
 * archived) never get the daemon's cascade cleanup. These helpers backstop
 * both. Pure functions tested here; the async wrappers are thin MCP calls.
 */
import { describe, expect, test } from "bun:test";
import {
	orphanedRunningIds,
	parseAgentList,
	runningChildrenOf,
	type AgentListItem,
} from "../paseo-channel.ts";

const PARENT = "parent-1";
const other = (over: Partial<AgentListItem>): AgentListItem => ({
	id: "x",
	status: "closed",
	labels: null,
	...over,
});

describe("parseAgentList — wire shapes", () => {
	test("unwraps {agents:[…]}", () => {
		const items = parseAgentList({
			agents: [{ id: "a1", status: "running", labels: { "subagent.role": "scout" } }],
		});
		expect(items).toHaveLength(1);
		expect(items[0].labels?.["subagent.role"]).toBe("scout");
	});

	test("unwraps {entries:[…]} and a bare array; drops bad rows", () => {
		expect(parseAgentList({ entries: [{ id: "e1" }] })).toHaveLength(1);
		expect(parseAgentList([{ id: "b1", status: null }, { id: "" }, 5, null])).toHaveLength(1);
		expect(parseAgentList({ agents: "nope" })).toHaveLength(0);
		expect(parseAgentList(undefined)).toHaveLength(0);
	});
});

describe("runningChildrenOf — cap source", () => {
	test("counts only RUNNING children of the parent (either parent label)", () => {
		const agents: AgentListItem[] = [
			other({ id: "c1", status: "running", labels: { "subagent.parent": PARENT } }),
			other({ id: "c2", status: "running", labels: { "paseo.parent-agent-id": PARENT } }),
			other({ id: "c3", status: "closed", labels: { "subagent.parent": PARENT } }), // finished — free
			other({ id: "c4", status: "running", labels: { "subagent.parent": "someone-else" } }),
			other({ id: "c5", status: "running", labels: null }),
		];
		expect(runningChildrenOf(agents, PARENT).map((a) => a.id)).toEqual(["c1", "c2"]);
	});
});

describe("orphanedRunningIds — sweep source", () => {
	test("running child with absent parent → orphan; alive parent / idle child / human agent → not", () => {
		const agents: AgentListItem[] = [
			other({ id: PARENT, status: "closed", labels: {} }), // parent alive in list (idle is fine)
			other({
				id: "orphan-1",
				status: "running",
				labels: { "subagent.role": "scout", "subagent.parent": "ghost" },
			}),
			other({
				id: "orphan-2",
				status: "running",
				labels: { "subagent.role": "worker", "paseo.parent-agent-id": "ghost" },
			}),
			other({
				id: "child-alive-parent",
				status: "running",
				labels: { "subagent.role": "scout", "subagent.parent": PARENT },
			}),
			other({
				id: "idle-orphan",
				status: "closed",
				labels: { "subagent.role": "scout", "subagent.parent": "ghost" },
			}),
			// human agent, parent label spoofed by coincidence — no subagent.role → untouched
			other({ id: "human", status: "running", labels: { "subagent.parent": "ghost" } }),
		];
		expect(orphanedRunningIds(agents).sort()).toEqual(["orphan-1", "orphan-2"]);
	});
});
