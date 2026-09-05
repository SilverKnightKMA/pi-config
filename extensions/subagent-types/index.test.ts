import { describe, expect, test } from "bun:test";
import {
	parseRoleMd,
	loadRoles,
	allowlistFor,
	spawnableRoles,
	mapToolName,
	floorTools,
	resolveSelf,
	providerStringFor,
	parseModelTags,
	thinkingValid,
	MODEL_GUIDANCE,
	resolveModel,
	MAIN_ROLE,
} from "./index";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("parseRoleMd", () => {
	test("parses frontmatter + body", () => {
		const raw = `---
name: tester
description: test role
tools: read, grep
model: some/model
subagent_agents: scout
thinking: low
---
You are a tester.`;
		const r = parseRoleMd("tester.md", raw);
		expect(r).not.toBeNull();
		expect(r!.name).toBe("tester");
		expect(r!.tools).toEqual(["read", "grep"]);
		expect(r!.subagentAgents).toEqual(["scout"]);
		expect(r!.model).toBe("some/model");
		expect(r!.systemPrompt).toContain("You are a tester.");
	});

	test("null on no frontmatter", () => {
		expect(parseRoleMd("x.md", "just body")).toBeNull();
	});
});

describe("role inventory (5 roles)", () => {
	test("all five roles load", () => {
		const roles = loadRoles();
		for (const name of ["scout", "researcher", "worker", "mermaid-maker", "svg-maker"]) {
			expect(roles.has(name), name).toBe(true);
		}
	});
});

describe("allowlistFor — the default-deny core", () => {
	const roles = loadRoles();

	test("scout: read-only recon set (registry-filtered to read on pi 0.84)", () => {
		const list = allowlistFor("scout", roles);
		expect(list).toContain("read");
		expect(list).not.toContain("bash");
		expect(list).not.toContain("write");
	});

	test("worker: implementation set with safe_bash replacing bash, plus spawn", () => {
		const list = allowlistFor("worker", roles);
		expect(list).toContain("safe_bash");
		expect(list).toContain("spawn_subagent");
		expect(list).not.toContain("bash");
		expect(list).not.toContain("subagent");
	});

	test("mermaid-maker: mermaid tools + read + channel tools", () => {
		expect(allowlistFor("mermaid-maker", roles)).toEqual([
			"write_mermaid",
			"edit_mermaid",
			"render_mermaid",
			"read",
			"message_main",
			"message_subagent",
			"ask_question",
		]);
	});

	test("UNKNOWN role → read-only floor (default-deny)", () => {
		expect(allowlistFor("hacker", roles)).toEqual(floorTools());
	});

	test("NO role → read-only floor", () => {
		expect(allowlistFor(undefined, roles)).toEqual(floorTools());
	});

	test("main → wildcard (keeps all tools)", () => {
		expect(allowlistFor(MAIN_ROLE, roles)).toEqual(["*"]);
	});
});

describe("spawnableRoles — depth control", () => {
	const roles = loadRoles();

	test("worker → scout, researcher only (author's depth-2 rule)", () => {
		expect(spawnableRoles("worker", roles)).toEqual(["scout", "researcher"]);
	});

	test("scout → nothing (leaf)", () => {
		expect(spawnableRoles("scout", roles)).toEqual([]);
	});

	test("unknown role → nothing", () => {
		expect(spawnableRoles("hacker", roles)).toEqual([]);
		expect(spawnableRoles(undefined, roles)).toEqual([]);
	});

	test("main → every defined role", () => {
		const s = spawnableRoles(MAIN_ROLE, roles);
		expect(s).toContain("worker");
		expect(s).toContain("mermaid-maker");
		expect(s.length).toBe(roles.size);
	});
});

describe("mapToolName", () => {
	test("identity — .md files now use live tool names", () => {
		expect(mapToolName("spawn_subagent")).toBe("spawn_subagent");
		expect(mapToolName("safe_bash")).toBe("safe_bash");
		expect(mapToolName("read")).toBe("read");
	});
});

describe("resolveSelf — sessionId → agent record → role", () => {
	const tmp = join(import.meta.dir, ".tmp-paseo-agents");

	function setup(records: Record<string, unknown>[]) {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "ws1"), { recursive: true });
		records.forEach((rec, i) => {
			writeFileSync(join(tmp, "ws1", `a${i}.json`), JSON.stringify(rec));
		});
	}

	test("matches by runtimeInfo.sessionId and reads role label", () => {
		setup([
			{
				id: "agent-1",
				runtimeInfo: { sessionId: "sess-123" },
				labels: { "subagent.role": "scout" },
			},
		]);
		const self = resolveSelf("sess-123", tmp);
		expect(self.agentId).toBe("agent-1");
		expect(self.role).toBe("scout");
	});

	test("no matching record → no role", () => {
		setup([]);
		const self = resolveSelf("sess-404", tmp);
		expect(self.agentId).toBeNull();
		expect(self.role).toBeUndefined();
	});

	test("record without role label, no parent → main (human-created)", () => {
		setup([
			{ id: "agent-2", runtimeInfo: { sessionId: "s2" }, labels: {} },
		]);
		expect(resolveSelf("s2", tmp).role).toBe("main");
	});

	test("anti-spoof: machine-spawned child claiming role main → default-deny floor, not main", () => {
		setup([
			{
				id: "agent-spoof",
				runtimeInfo: { sessionId: "s-spoof" },
				// daemon stamps paseo.parent-agent-id AFTER caller labels merge,
				// so both labels coexisting = escalation attempt
				labels: { "subagent.role": "main", "paseo.parent-agent-id": "agent-parent" },
			},
		]);
		const self = resolveSelf("s-spoof", tmp);
		expect(self.role).not.toBe("main"); // never full tools
		expect(self.role).toBeUndefined(); // falls to default-deny floor
	});

	test("machine-spawned child with honest role label → keeps that role", () => {
		setup([
			{
				id: "agent-honest",
				runtimeInfo: { sessionId: "s-honest" },
				labels: { "subagent.role": "researcher", "paseo.parent-agent-id": "agent-parent" },
			},
		]);
		expect(resolveSelf("s-honest", tmp).role).toBe("researcher");
	});

	test("corrupt JSON record is skipped, not fatal", () => {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "ws1"), { recursive: true });
		writeFileSync(join(tmp, "ws1", "bad.json"), "{not json");
		writeFileSync(join(tmp, "ws1", "good.json"), JSON.stringify({
			id: "agent-3",
			runtimeInfo: { sessionId: "s3" },
			labels: { "subagent.role": "worker" },
		}));
		const self = resolveSelf("s3", tmp);
		expect(self.role).toBe("worker");
	});

	test("persistence.sessionId fallback also matches", () => {
		setup([
			{ id: "agent-4", persistence: { sessionId: "s4" }, labels: { "subagent.role": "researcher" } },
		]);
		expect(resolveSelf("s4", tmp).role).toBe("researcher");
	});

	rmSync(tmp, { recursive: true, force: true });
});

describe("resolveModel — fallback mapping", () => {
	const available = ["cli-openai/zaicp/glm-5.3", "cli-openai/zaicp/glm-5.3-flash"];

	test("haiku pin → flash model", () => {
		expect(resolveModel("anthropic/claude-haiku-4-5", available)).toBe("cli-openai/zaicp/glm-5.3-flash");
	});

	test("sonnet pin → full model", () => {
		expect(resolveModel("anthropic/claude-sonnet-5", available)).toBe("cli-openai/zaicp/glm-5.3");
	});

	test("already-available model passes through", () => {
		expect(resolveModel("cli-openai/zaicp/glm-5.3", available)).toBe("cli-openai/zaicp/glm-5.3");
	});

	test("unmappable pin → undefined (caller default)", () => {
		expect(resolveModel("mystery/model", available)).toBeUndefined();
	});
});

describe("resolveSelf — human vs machine origin", () => {
	const tmp = join(import.meta.dir, ".tmp-origin");
	function setup(record: Record<string, unknown>) {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(join(tmp, "ws"), { recursive: true });
		writeFileSync(join(tmp, "ws", "a.json"), JSON.stringify(record));
	}

	test("explicit role label wins", () => {
		setup({ id: "a", runtimeInfo: { sessionId: "s" }, labels: { "subagent.role": "worker" } });
		expect(resolveSelf("s", tmp).role).toBe("worker");
	});

	test("human-created (no parent label) → main", () => {
		setup({ id: "a", runtimeInfo: { sessionId: "s" }, labels: {} });
		expect(resolveSelf("s", tmp).role).toBe("main");
	});

	test("machine-spawned without role → floor (undefined)", () => {
		setup({ id: "a", runtimeInfo: { sessionId: "s" }, labels: { "paseo.parent-agent-id": "parent-1" } });
		expect(resolveSelf("s", tmp).role).toBeUndefined();
	});

	test("machine-spawned WITH role → that role", () => {
		setup({
			id: "a",
			runtimeInfo: { sessionId: "s" },
			labels: { "paseo.parent-agent-id": "parent-1", "subagent.role": "scout" },
		});
		expect(resolveSelf("s", tmp).role).toBe("scout");
	});

	rmSync(tmp, { recursive: true, force: true });
});

describe("providerStringFor", () => {
	test("bare model id gets pi/ prefix", () => {
		expect(providerStringFor("cli-openai/zaicp/glm-5.3")).toBe("pi/cli-openai/zaicp/glm-5.3");
	});
	test("already-prefixed passes through", () => {
		expect(providerStringFor("pi/cli-openai/zaicp/glm-5.3")).toBe("pi/cli-openai/zaicp/glm-5.3");
	});
});

describe("parseModelTags", () => {
	test("vision + reasoning from tags", () => {
		expect(parseModelTags("[GLM-5.3-Flash][ZAI][T][V][XL]")).toEqual({ vision: true, reasoning: true });
	});
	test("text-only model", () => {
		expect(parseModelTags("[GLM-5.2][ZAI][T]")).toEqual({ vision: false, reasoning: true });
	});
	test("missing name → all false", () => {
		expect(parseModelTags(undefined)).toEqual({ vision: false, reasoning: false });
	});
});

describe("thinkingValid", () => {
	test("valid pi levels", () => {
		for (const lvl of ["off", "medium", "max"]) expect(thinkingValid(lvl, "pi")).toBe(true);
	});
	test("invalid level rejected", () => {
		expect(thinkingValid("ultra", "pi")).toBe(false);
		expect(thinkingValid("", "pi")).toBe(false);
		expect(thinkingValid(undefined, "pi")).toBe(false);
	});
	test("unknown provider → fail closed", () => {
		expect(thinkingValid("high", "mystery-provider")).toBe(false);
	});
});

describe("MODEL_GUIDANCE", () => {
	test("generic: no specific model names pinned", () => {
		expect(MODEL_GUIDANCE).toContain("[V]");
		expect(MODEL_GUIDANCE).toContain("thinkingOptionId");
		// must not name any concrete model of this machine
		expect(MODEL_GUIDANCE).not.toMatch(/glm|minimax|deepseek/i);
	});
});
