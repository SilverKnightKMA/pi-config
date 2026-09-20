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
import { join } from "node:path";

export const REPLY_DOOR_TOOL = "reply_to_parent";

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
		const res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body,
			signal: AbortSignal.timeout(30_000),
		});
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
