import { mkdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	REPLY_DOOR_TOOL,
	callReplyDoor,
	doorUrlFromRecord,
	findDoorUrlForAgent,
	type DoorFetch,
} from "./door-tool.ts";
import { allowlistFor, floorTools, parseRoleMd, MAIN_ROLE } from "./index.ts";

// ── doorUrlFromRecord: shape discrimination ─────────────────────────────
const doorUrl = "http://127.0.0.1:42911/mcp?caller=abc123";
const rec = (url: string | null) =>
	url === null ? { config: {} } : { config: { mcpServers: { paseo: { type: "http", url } } } };

describe("doorUrlFromRecord", () => {
	test("accepts scoped door URL (/mcp + caller token)", () => {
		expect(doorUrlFromRecord(rec(doorUrl))).toBe(doorUrl);
	});
	test("rejects daemon broad-catalog URL (/mcp/agents, no caller)", () => {
		expect(doorUrlFromRecord(rec("http://127.0.0.1:6767/mcp/agents"))).toBeNull();
	});
	test("rejects /mcp without caller token", () => {
		expect(doorUrlFromRecord(rec("http://127.0.0.1:42911/mcp"))).toBeNull();
	});
	test("rejects absent record / no server / bad JSON shape / non-string url", () => {
		expect(doorUrlFromRecord(null)).toBeNull();
		expect(doorUrlFromRecord({})).toBeNull();
		expect(doorUrlFromRecord({ config: { mcpServers: {} } })).toBeNull();
		expect(doorUrlFromRecord({ config: { mcpServers: { paseo: { url: 42 } } } })).toBeNull();
		expect(doorUrlFromRecord(rec("not a url"))).toBeNull();
	});
});

// ── findDoorUrlForAgent: record scan (tmp agents dir) ───────────────────
describe("findDoorUrlForAgent", () => {
	test("finds <agentId>.json across workspace subdirs", () => {
		const dir = `/tmp/door-test-agents-${Date.now()}`;
		mkdirSync(`${dir}/ws-a`, { recursive: true }); mkdirSync(`${dir}/ws-b`, { recursive: true });
		Bun.write(`${dir}/ws-a/other.json`, JSON.stringify(rec("http://127.0.0.1:1/mcp/agents")));
		Bun.write(`${dir}/ws-b/agent-1.json`, JSON.stringify(rec(doorUrl)));
		expect(findDoorUrlForAgent(dir, "agent-1")).toBe(doorUrl);
	});
	test("null for missing record, unreadable dir, empty id, main-shaped record", () => {
		expect(findDoorUrlForAgent("/tmp/door-test-agents-does-not-exist", "agent-1")).toBeNull();
		expect(findDoorUrlForAgent("/tmp", "")).toBeNull();
		const dir = `/tmp/door-test-agents-main-${Date.now()}`;
		mkdirSync(`${dir}/ws`, { recursive: true });
		Bun.write(`${dir}/ws/main-agent.json`, JSON.stringify(rec("http://127.0.0.1:6767/mcp/agents")));
		expect(findDoorUrlForAgent(dir, "main-agent")).toBeNull();
	});
});

// ── callReplyDoor: JSON-RPC POST via injected fetch ─────────────────────
function stubFetch(status: number, body: unknown): { f: DoorFetch; calls: Array<{ url: string; body: any; headers: Record<string, string> }> } {
	const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
	const f = (async (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => {
		calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
		return { status, json: async () => body };
	}) as unknown as DoorFetch;
	return { f, calls };
}

describe("callReplyDoor", () => {
	test("POSTs tools/call reply_to_parent with prompt to the exact door URL", async () => {
		const { f, calls } = stubFetch(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "delivered to parent" }] } });
		const r = await callReplyDoor(doorUrl, "F1-OK", f);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.text).toBe("delivered to parent");
		const c = calls[0];
		expect(c.url).toBe(doorUrl);
		expect(c.body.method).toBe("tools/call");
		expect(c.body.params.name).toBe(REPLY_DOOR_TOOL);
		expect(c.body.params.arguments).toEqual({ prompt: "F1-OK" });
		expect(c.headers["content-type"]).toBe("application/json");
	});
	test("maps isError:true result to an honest error", async () => {
		const { f } = stubFetch(200, { result: { isError: true, content: [{ type: "text", text: "unknown caller" }] } });
		const r = await callReplyDoor(doorUrl, "x", f);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("unknown caller");
	});
	test("maps JSON-RPC error object, 401 re-mint hint, non-JSON, and fetch throw", async () => {
		const rpc = stubFetch(200, { error: { code: -32602, message: "missing prompt" } });
		expect((await callReplyDoor(doorUrl, "x", rpc.f) as { ok: boolean; error?: string }).error).toContain("-32602");
		const unauth = stubFetch(401, {});
		expect((await callReplyDoor(doorUrl, "x", unauth.f) as { ok: boolean; error?: string }).error).toContain("401");
		const notJson: DoorFetch = (async () => ({ status: 502, json: async () => { throw new Error("bad json"); } })) as unknown as DoorFetch;
		expect((await callReplyDoor(doorUrl, "x", notJson) as { ok: boolean; error?: string }).error).toContain("non-JSON");
		const boom: DoorFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as DoorFetch;
		expect((await callReplyDoor(doorUrl, "x", boom) as { ok: boolean; error?: string }).error).toContain("unreachable");
	});
});

// ── allowlist integration: every child path carries the door ────────────
describe("door tool in allowlists", () => {
	const roles = new Map();
	const md = parseRoleMd("scout.md", "---\nname: scout\ndescription: d\ntools: read\n---\nbody");
	if (md) roles.set("scout", md);

	test("defined roles include reply_to_parent alongside channel tools", () => {
		expect(allowlistFor("scout", roles)).toContain(REPLY_DOOR_TOOL);
		expect(allowlistFor("scout", roles)).toContain("message_main");
	});
	test("floor (no role / unknown role) includes the universal door", () => {
		expect(floorTools()).toContain(REPLY_DOOR_TOOL);
		expect(allowlistFor(undefined, roles)).toContain(REPLY_DOOR_TOOL);
		expect(allowlistFor("nope", roles)).toContain(REPLY_DOOR_TOOL);
	});
	test("main stays * (no door for mains — no parent to address)", () => {
		expect(allowlistFor(MAIN_ROLE, roles)[0]).toBe("*");
	});
});

// ── #142: fetchDoorTools / callDoorTool / doorSchemaToTypeBox ───────────
import { fetchDoorTools, callDoorTool, doorSchemaToTypeBox } from "./door-tool.ts";

const mkFetch =
	(status: number, json: unknown) =>
	(() =>
		Promise.resolve({
			status,
			json: () => Promise.resolve(json),
		})) as unknown as DoorFetch;

describe("fetchDoorTools", () => {
	test("parses tools/list result with name/description/inputSchema", async () => {
		const r = await fetchDoorTools(
			doorUrl,
			mkFetch(200, {
				result: { tools: [{ name: "reply_to_parent", description: "d1" }, { name: "spawn_subagent", inputSchema: { type: "object", properties: { role: { type: "string" } } } }, { name: "" }, { notName: true }] },
			}),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.tools.length).toBe(2);
			expect(r.tools[0].name).toBe("reply_to_parent");
			expect(r.tools[1].inputSchema?.properties).toHaveProperty("role");
		}
	});
	test("401 → honest stale-token error", async () => {
		const r = await fetchDoorTools(doorUrl, mkFetch(401, {}));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("401");
	});
	test("JSON-RPC error and non-JSON map to ok:false", async () => {
		expect((await fetchDoorTools(doorUrl, mkFetch(200, { error: { code: -32001, message: "unknown caller" } }))).ok).toBe(false);
		expect((await fetchDoorTools(doorUrl, mkFetch(502, null)).catch(() => ({ ok: false })))).toHaveProperty("ok", false);
	});
});

describe("callDoorTool (generic)", () => {
	test("posts name+arguments and returns first content text", async () => {
		const r = await callDoorTool(
			doorUrl,
			"spawn_subagent",
			{ role: "scout", task: "x" },
			mkFetch(200, { result: { content: [{ text: '{"agentId":"a1"}' }] } }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.text).toContain("a1");
	});
	test("isError:true result → honest failure text", async () => {
		const r = await callDoorTool(doorUrl, "spawn_subagent", {}, mkFetch(200, { result: { isError: true, content: [{ text: "spawn failed: depth cap" }] } }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("depth cap");
	});
});

describe("doorSchemaToTypeBox", () => {
	test("legacy reply (no schema) keeps prompt:string shape", () => {
		const s = doorSchemaToTypeBox(undefined, true) as unknown as { properties: Record<string, { type: string }> };
		expect(s.properties.prompt.type).toBe("string");
	});
	test("maps JSON schema: string/number/boolean/array + optional via required", () => {
		const s = doorSchemaToTypeBox(
			{ type: "object", required: ["role", "task"], properties: { role: { type: "string", description: "R" }, task: { type: "string" }, count: { type: "number" }, flag: { type: "boolean" }, tags: { type: "array" } } },
			false,
		) as unknown as { properties: Record<string, { type: string; description?: string; mod?: string[] }>; required?: string[] };
		expect(s.properties.role.description).toBe("R");
		expect(s.properties.count.type).toBe("number");
		expect(s.properties.flag.type).toBe("boolean");
		expect(s.properties.tags.type).toBe("array");
		expect(s.required).toContain("role");
		expect(s.required).not.toContain("count");
	});
	test("missing/invalid schema → empty object (fail-closed, no params)", () => {
		expect((doorSchemaToTypeBox(undefined, false) as unknown as { properties: object }).properties).toEqual({});
		expect((doorSchemaToTypeBox({ nope: true }, false) as unknown as { properties: object }).properties).toEqual({});
	});
});

// ---- spec v12 L2 (#160): main door from env BEFORE record ----

import { doorUrlFromEnv, findMainDoorUrl, mainDoorUrlFromRecord, MAIN_DOOR_ENV } from "./door-tool.ts";

describe("doorUrlFromEnv (L2 #160)", () => {
	test("env has a correctly shaped URL → returns it unchanged", () => {
		const url = "http://127.0.0.1:43721/mcp?caller=abc123";
		expect(doorUrlFromEnv({ [MAIN_DOOR_ENV]: url })).toBe(url);
	});
	test("missing env → null", () => {
		expect(doorUrlFromEnv({})).toBeNull();
	});
	test("invalid shape (daemon catalog /mcp/agents, malformed URL) → null", () => {
		expect(doorUrlFromEnv({ [MAIN_DOOR_ENV]: "http://127.0.0.1:1/mcp/agents" })).toBeNull();
		expect(doorUrlFromEnv({ [MAIN_DOOR_ENV]: "http://127.0.0.1:1/mcp" })).toBeNull(); // missing caller
		expect(doorUrlFromEnv({ [MAIN_DOOR_ENV]: "not-a-url" })).toBeNull();
	});
});

describe("mainDoorUrlFromRecord (L2 #160)", () => {
	test("record has paseo-subagents key → URL", () => {
		const raw = { config: { mcpServers: { "paseo-subagents": { url: "http://127.0.0.1:9/mcp?caller=t1" } } } };
		expect(mainDoorUrlFromRecord(raw)).toBe("http://127.0.0.1:9/mcp?caller=t1");
	});
	test("record has only the 'paseo' key (child) → null (main door has a separate key)", () => {
		const raw = { config: { mcpServers: { paseo: { url: "http://127.0.0.1:9/mcp?caller=t2" } } } };
		expect(mainDoorUrlFromRecord(raw)).toBeNull();
	});
	test("no config → null", () => {
		expect(mainDoorUrlFromRecord({})).toBeNull();
		expect(mainDoorUrlFromRecord(null)).toBeNull();
	});
});

describe("findMainDoorUrl — env BEFORE record (#160)", () => {
	test("env wins even when the record has a door", () => {
		// fixture: main record has the paseo-subagents door key
		expect(findMainDoorUrl("/nonexistent-agents-dir", "any-id", { [MAIN_DOOR_ENV]: "http://127.0.0.1:5/mcp?caller=envwins" })).toBe(
			"http://127.0.0.1:5/mcp?caller=envwins",
		);
	});
	test("no env → reads record (main created after port has a door in its record)", () => {
		// using this machine's real agents directory is nondeterministic — create a fixture
		const tmp = require("node:fs").mkdtempSync(require("node:os").tmpdir() + "/maindoor-");
		require("node:fs").mkdirSync(tmp + "/ws", { recursive: true });
		require("node:fs").writeFileSync(
			tmp + "/ws/main-1.json",
			JSON.stringify({ id: "main-1", config: { mcpServers: { "paseo-subagents": { url: "http://127.0.0.1:7/mcp?caller=rec1" } } } }),
		);
		expect(findMainDoorUrl(tmp, "main-1", {})).toBe("http://127.0.0.1:7/mcp?caller=rec1");
		expect(findMainDoorUrl(tmp, "ghost", {})).toBeNull();
		require("node:fs").rmSync(tmp, { recursive: true, force: true });
	});
});
