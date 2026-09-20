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
		Bun.spawnSync(["mkdir", "-p", `${dir}/ws-a`, `${dir}/ws-b`]);
		Bun.write(`${dir}/ws-a/other.json`, JSON.stringify(rec("http://127.0.0.1:1/mcp/agents")));
		Bun.write(`${dir}/ws-b/agent-1.json`, JSON.stringify(rec(doorUrl)));
		expect(findDoorUrlForAgent(dir, "agent-1")).toBe(doorUrl);
	});
	test("null for missing record, unreadable dir, empty id, main-shaped record", () => {
		expect(findDoorUrlForAgent("/tmp/door-test-agents-does-not-exist", "agent-1")).toBeNull();
		expect(findDoorUrlForAgent("/tmp", "")).toBeNull();
		const dir = `/tmp/door-test-agents-main-${Date.now()}`;
		Bun.spawnSync(["mkdir", "-p", `${dir}/ws`]);
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
