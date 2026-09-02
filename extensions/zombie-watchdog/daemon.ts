/**
 * Minimal daemon JSON-RPC client for the zombie-watchdog.
 *
 * Standalone copy (deliberately not imported from subagent-types) so this
 * extension has zero coupling: it only needs get_agent_status for SELF.
 *
 * Endpoint discovery mirrors paseo-channel.ts: Paseo provisions a loopback MCP
 * endpoint per spawned pi process under tmpdir()/paseo-pi-mcp-<id>/mcp.json,
 * whose URL carries callerAgentId=<uuid>. We match our own PASEO_AGENT_ID exactly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface McpEndpoint {
	url: string;
	token: string;
}

export function findMcpEndpoint(callerAgentId?: string | null, tmp = tmpdir()): McpEndpoint | undefined {
	const dirs: string[] = [];
	try {
		for (const entry of readdirSync(tmp)) {
			if (entry.startsWith("paseo-pi-mcp-")) dirs.push(join(tmp, entry));
		}
	} catch {
		return undefined;
	}
	const configs = dirs
		.map((d) => join(d, "mcp.json"))
		.filter((p) => existsSync(p))
		.sort((a, b) => statTime(b) - statTime(a));
	for (const cfg of configs) {
		try {
			const d = JSON.parse(readFileSync(cfg, "utf-8"));
			const server = d?.mcpServers?.paseo;
			const url: string | undefined = server?.url;
			const auth: string | undefined = server?.headers?.Authorization;
			if (!url || !auth?.startsWith("Bearer ")) continue;
			if (callerAgentId) {
				const m = /callerAgentId=([0-9a-f-]+)/.exec(url);
				if (!m || m[1] !== callerAgentId) continue;
			}
			return { url, token: auth.slice("Bearer ".length) };
		} catch {
			// skip malformed
		}
	}
	return undefined;
}

let callSeq = 0;

/** Low-level MCP JSON-RPC tools/call. */
export async function mcpCall(
	endpoint: McpEndpoint,
	tool: string,
	args: Record<string, unknown>,
	timeoutMs = 10_000,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	// NOTE: the id field is MANDATORY — without it JSON-RPC 2.0 treats the
	// request as a notification: the daemon processes it but never replies
	// (Express answers 202 with an empty body). This bit us once; never drop it.
	const body = {
		jsonrpc: "2.0",
		id: ++callSeq,
		method: "tools/call",
		params: { name: tool, arguments: args },
	};
	try {
		const res = await fetchImpl(endpoint.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${endpoint.token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		// The daemon answers MCP over SSE frames; keep the last good data: frame.
		let payload: unknown;
		for (const line of text.split("\n")) {
			if (line.startsWith("data: ")) {
				try {
					payload = JSON.parse(line.slice(6));
				} catch {
					// keep last good frame
				}
			}
		}
		if (!payload) return { ok: false, error: `no MCP response (http ${res.status})` };
		const result = (payload as { result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> } }).result;
		if (result?.isError) {
			return { ok: false, error: (result.content?.[0]?.text ?? "tool failed").slice(0, 300) };
		}
		return { ok: true, data: result?.structuredContent ?? result?.content };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function getAgentStatus(
	endpoint: McpEndpoint,
	agentId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: string; error?: string }> {
	const r = await mcpCall(endpoint, "get_agent_status", { agentId }, 10_000, fetchImpl);
	if (!r.ok) return { ok: false, error: r.error };
	// data is structuredContent when the daemon sends it, else the content array
	// whose [0].text carries the JSON string.
	let sc: { status?: string; snapshot?: { lastStatus?: string } } = {};
	if (Array.isArray(r.data)) {
		const txt = (r.data as Array<{ text?: string }>)[0]?.text;
		try {
			sc = txt ? JSON.parse(txt) : {};
		} catch {
			sc = {};
		}
	} else {
		sc = (r.data as typeof sc) ?? {};
	}
	return { ok: true, status: sc.status ?? sc.snapshot?.lastStatus };
}

export function isBusy(status: string | undefined): boolean {
	return status === "running" || status === "initializing";
}

function statTime(p: string): number {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}
