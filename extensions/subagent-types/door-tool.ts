/**
 * reply_to_parent door tool — extension-registered transport (#128 / F1).
 *
 * 2026-09-20 user decision (learn/decision-2026-09-20-door-direction.md):
 * ONE universal child→parent door for every provider and every parent
 * harness. The MCP-client path already works for codex/claude children; pi
 * 0.85.1 does not register tools from http MCP servers, so for pi children
 * the extension registers reply_to_parent as a native extension tool and
 * POSTs the JSON-RPC call straight to the door URL — the plugin, token
 * registry and [child-report] envelope stay identical for all providers.
 *
 * The door URL (with caller token) is read from the child's OWN agent record:
 *   ~/.paseo/agents/<ws>/<agentId>.json → config.mcpServers.paseo.url
 * written there by the subagent-reply plugin's before("agent.create") hook.
 * Door URLs are discriminated from the daemon's broad catalog by shape:
 * pathname === "/mcp" plus a "caller" query token (the daemon's internal
 * endpoint is /mcp/agents and carries no caller).
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";

export const REPLY_DOOR_TOOL = "reply_to_parent";

/** F10 (#219): the paseo-subagents door port rotates on every plugin restart,
 *  while session env vars and child records freeze the port they were born
 *  with. The plugin persists its CURRENT port in door-state.json; on a
 *  network-level failure we rebuild the URL with that port and retry ONCE —
 *  the caller token is opaque and stays valid (adopted from records or the
 *  plugin's grants.json), so only the port ever needs re-discovery. */
// Resolved at CALL time so tests (and harnesses) can pin a hermetic state file
// via PASEO_SUBAGENTS_DOOR_STATE — a module-level const froze too early and made
// the retry test depend on the REAL daemon state existing or not (#234 note:
// it started failing the day the live door-state.json pointed at a LIVE door).
function doorStateFile(): string {
	return process.env.PASEO_SUBAGENTS_DOOR_STATE ?? join(homedir(), ".paseo", "plugin-data", "paseo-subagents", "door-state.json");
}

export function readDoorDiscovery(stateFile: string = doorStateFile()): number | null {
	try {
		const raw = JSON.parse(readFileSync(stateFile, "utf-8")) as { port?: unknown };
		if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null;
		return raw.port;
	} catch {
		return null;
	}
}

/** Rebuild a door URL around a new port, keeping path + caller token. */
export function withPort(url: string, port: number): string {
	try {
		const u = new URL(url);
		u.port = String(port);
		return u.toString();
	} catch {
		return url;
	}
}

/** doorFetch — fetch a door URL; when the network call itself fails (stale
 *  port after a plugin restart), re-discover the live port and retry once.
 *  Exported (with an injectable state file) for unit tests. */
export async function doorFetch(
	url: string,
	init: Parameters<DoorFetch>[1],
	fetchImpl: DoorFetch,
	stateFile: string = doorStateFile(),
): Promise<Awaited<ReturnType<DoorFetch>>> {
	try {
		return await fetchImpl(url, init);
	} catch (err) {
		const port = readDoorDiscovery(stateFile);
		if (port === null) throw err;
		const retryUrl = withPort(url, port);
		if (retryUrl === url) throw err;
		return await fetchImpl(retryUrl, init);
	}
}

/** Env L2 (spec v12 · #160): the paseo-subagents plugin assigns
 *  PASEO_SUBAGENTS_DOOR to a main agent without a door (created before the
 *  plugin) through before(agent.session_open). Read BEFORE the record — env
 *  is always fresher than disk for a live agent. */
export const MAIN_DOOR_ENV = "PASEO_SUBAGENTS_DOOR";
export const MAIN_MCP_KEY = "paseo-subagents";

/** Door URL from env; null when missing or incorrectly shaped (/mcp + caller token). */
export function doorUrlFromEnv(env: Record<string, string | undefined> = process.env): string | null {
	const url = env[MAIN_DOOR_ENV];
	if (typeof url !== "string" || url.length === 0) return null;
	try {
		const u = new URL(url);
		if (u.pathname !== "/mcp" || !u.searchParams.has("caller")) return null;
		return url;
	} catch {
		return null;
	}
}

/** Primary door URL (spawn door) from the 'paseo-subagents' record key — the
 *  plugin adds a door to main at creation (post-port). Same shape check as the child door. */
export function mainDoorUrlFromRecord(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	const cfg = (raw as Record<string, unknown>).config;
	if (typeof cfg !== "object" || cfg === null) return null;
	const servers = (cfg as Record<string, unknown>).mcpServers;
	if (typeof servers !== "object" || servers === null) return null;
	const main = (servers as Record<string, unknown>)[MAIN_MCP_KEY];
	if (typeof main !== "object" || main === null) return null;
	const url = (main as Record<string, unknown>).url;
	if (typeof url !== "string" || url.length === 0) return null;
	try {
		const u = new URL(url);
		if (u.pathname !== "/mcp" || !u.searchParams.has("caller")) return null;
		return url;
	} catch {
		return null;
	}
}

/** MAIN's primary door: env BEFORE record (spec v12 L2 · #160). */
export function findMainDoorUrl(agentsDir: string, agentId: string, env: Record<string, string | undefined> = process.env): string | null {
	const fromEnv = doorUrlFromEnv(env);
	if (fromEnv) return fromEnv;
	if (!agentId) return null;
	let workspaces: Dirent[];
	try {
		workspaces = readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of workspaces) {
		if (!entry.isDirectory()) continue;
		const recordPath = join(agentsDir, entry.name, `${agentId}.json`);
		let raw: string;
		try {
			raw = readFileSync(recordPath, "utf8");
		} catch {
			continue;
		}
		try {
			return mainDoorUrlFromRecord(JSON.parse(raw));
		} catch {
			return null;
		}
	}
	return null;
}

/** Extract the scoped door URL from a parsed agent record; null when the
 * record is absent, has no paseo MCP server, or the URL is not the scoped
 * door shape (main agents keep the broad catalog → null → no tool). */
export function doorUrlFromRecord(raw: unknown): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	const cfg = (raw as Record<string, unknown>).config;
	if (typeof cfg !== "object" || cfg === null) return null;
	const servers = (cfg as Record<string, unknown>).mcpServers;
	if (typeof servers !== "object" || servers === null) return null;
	const paseo = (servers as Record<string, unknown>).paseo;
	if (typeof paseo !== "object" || paseo === null) return null;
	const url = (paseo as Record<string, unknown>).url;
	if (typeof url !== "string" || url.length === 0) return null;
	try {
		const u = new URL(url);
		if (u.pathname !== "/mcp" || !u.searchParams.has("caller")) return null;
		return url;
	} catch {
		return null;
	}
}

/** Locate <agentId>.json under the agents dir (one workspace subdir per
 * workspace slug) and return its door URL, or null when there is no scoped
 * door for this agent. Never throws: unreadable/absent records → null. */
export function findDoorUrlForAgent(agentsDir: string, agentId: string): string | null {
	if (!agentId) return null;
	let workspaces: Dirent[];
	try {
		workspaces = readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of workspaces) {
		if (!entry.isDirectory()) continue;
		const recordPath = join(agentsDir, entry.name, `${agentId}.json`);
		let raw: string;
		try {
			raw = readFileSync(recordPath, "utf8");
		} catch {
			continue; // not this workspace's record
		}
		try {
			return doorUrlFromRecord(JSON.parse(raw));
		} catch {
			return null; // corrupt record for this exact agent id — do not scan on
		}
	}
	return null;
}

export type DoorFetch = (
	url: string,
	init: {
		method: "POST";
		headers: Record<string, string>;
		body: string;
		signal: AbortSignal;
	},
) => Promise<{
	status: number;
	json(): Promise<unknown>;
}>;

export type DoorResult = { ok: true; text: string } | { ok: false; error: string };

/** POST one tools/call(reply_to_parent) to the scoped door. Never throws:
 * every failure mode maps to an honest machine-readable error string. */
export async function callReplyDoor(
	url: string,
	prompt: string,
	fetchImpl: DoorFetch = fetch as unknown as DoorFetch,
): Promise<DoorResult> {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: REPLY_DOOR_TOOL, arguments: { prompt } },
	});
	try {
		const res = await doorFetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body,
			signal: AbortSignal.timeout(30_000),
		}, fetchImpl);
		if (res.status === 401) {
			return {
				ok: false,
				error:
					"reply door rejected this session's caller token (401) — the daemon/plugin may have restarted and re-minted tokens; if message_main exists report there instead",
			};
		}
		const data = (await res.json().catch(() => null)) as
			| {
					error?: { code?: number; message?: string };
					result?: { isError?: boolean; content?: Array<{ text?: string }> };
			  }
			| null;
		if (!data) return { ok: false, error: `reply door returned non-JSON (HTTP ${res.status})` };
		if (data.error) {
			return { ok: false, error: `reply door error ${data.error.code ?? ""}: ${data.error.message ?? "unknown"}` };
		}
		const text = data.result?.content?.[0]?.text;
		if (data.result?.isError) return { ok: false, error: text ?? "reply door execute failed" };
		return { ok: true, text: text ?? "delivered" };
	} catch (err) {
		return { ok: false, error: `reply door unreachable: ${String(err)}` };
	}
}

/** Map a door tool's JSON Schema (loose) to a TypeBox object — deterministic,
 *  unknown property types degrade to string; optional honored via `required`. */
export function doorSchemaToTypeBox(
	schema: Record<string, unknown> | undefined,
	isReplyLegacy: boolean,
): TSchema {
	if (isReplyLegacy && !schema) {
		return Type.Object({
			prompt: Type.String({ description: "Your report, key findings, question, or decision request for the parent." }),
		});
	}
	if (!schema || typeof schema !== "object") return Type.Object({});
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
	if (!props || typeof props !== "object") return Type.Object({});
	const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []);
	const out: Record<string, TSchema> = {};
	for (const [key, p] of Object.entries(props)) {
		const desc = typeof p?.description === "string" ? p.description : undefined;
		let t: TSchema;
		switch (p?.type) {
			case "number":
			case "integer":
				t = Type.Number({ description: desc });
				break;
			case "boolean":
				t = Type.Boolean({ description: desc });
				break;
			case "array":
				t = Type.Array(Type.Unknown(), { description: desc });
				break;
			default:
				t = Type.String({ description: desc });
		}
		out[key] = required.has(key) ? t : Type.Optional(t);
	}
	return Type.Object(out);
}

// ── Door proxy generalization (#142 / plan step 8) ────────────────────────
// The scoped door already filters its tool list by caller (canSpawn/depth).
// A pi child cannot register http MCP tools natively (pi 0.85.1), so the
// shim fetches tools/list ONCE from the door and registers a native proxy
// for every tool it is allowed to see — reply_to_parent today, spawn tools
// when the role permits grandchildren. Fail-closed: fetch error → fall back
// to registering reply_to_parent only (v1.4.103 behavior).

export interface DoorToolSpec {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export type DoorToolsResult = { ok: true; tools: DoorToolSpec[] } | { ok: false; error: string };

/** POST tools/list to the scoped door. Never throws. */
export async function fetchDoorTools(
	url: string,
	fetchImpl: DoorFetch = fetch as unknown as DoorFetch,
): Promise<DoorToolsResult> {
	const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	try {
		const res = await doorFetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body,
			signal: AbortSignal.timeout(10_000),
		}, fetchImpl);
		if (res.status === 401) {
			return { ok: false, error: "door rejected this session's caller token (401) — token stale after daemon/plugin restart" };
		}
		const data = (await res.json().catch(() => null)) as
			| { error?: { code?: number; message?: string }; result?: { tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> } }
			| null;
		if (!data) return { ok: false, error: `door tools/list returned non-JSON (HTTP ${res.status})` };
		if (data.error) return { ok: false, error: `door tools/list error ${data.error.code ?? ""}: ${data.error.message ?? "unknown"}` };
		const tools = (data.result?.tools ?? [])
			.filter((t): t is { name: string; description?: string; inputSchema?: Record<string, unknown> } => typeof t?.name === "string" && t.name.length > 0)
			.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
		return { ok: true, tools };
	} catch (err) {
		return { ok: false, error: `door unreachable: ${String(err)}` };
	}
}

/** POST one tools/call for ANY door tool. Never throws. */
export async function callDoorTool(
	url: string,
	name: string,
	args: Record<string, unknown>,
	fetchImpl: DoorFetch = fetch as unknown as DoorFetch,
): Promise<DoorResult> {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
	try {
		const res = await doorFetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body,
			signal: AbortSignal.timeout(60_000),
		}, fetchImpl);
		if (res.status === 401) {
			return { ok: false, error: `door rejected this session's caller token (401) for tool '${name}' — token stale after restart` };
		}
		const data = (await res.json().catch(() => null)) as
			| { error?: { code?: number; message?: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } }
			| null;
		if (!data) return { ok: false, error: `door returned non-JSON (HTTP ${res.status}) for tool '${name}'` };
		if (data.error) return { ok: false, error: `door error ${data.error.code ?? ""} for tool '${name}': ${data.error.message ?? "unknown"}` };
		const text = data.result?.content?.[0]?.text;
		if (data.result?.isError) return { ok: false, error: text ?? `door tool '${name}' failed` };
		return { ok: true, text: text ?? "ok" };
	} catch (err) {
		return { ok: false, error: `door unreachable for tool '${name}': ${String(err)}` };
	}
}
