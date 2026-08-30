/**
 * Direct agent-creation client for the Paseo daemon's agent MCP endpoint.
 *
 * The daemon exposes /mcp/agents on loopback, authenticated by a per-run
 * capability token that it injects into each agent's temp MCP config
 * the paseo-pi-mcp temp configs. Reading that config and POSTing a JSON-RPC
 * tools/call is the same channel the session's own MCP tools use — no
 * credentials beyond what the daemon already provisioned for this agent.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";

interface McpEndpoint {
	url: string;
	token: string;
}

/** Locate the newest paseo MCP config carrying url + bearer token. */
export function findMcpEndpoint(callerAgentId?: string | null, tmp = tmpdir()): McpEndpoint | undefined {
	const dirs: string[] = [];
	try {
		for (const entry of readdirSync(tmp)) {
			if (entry.startsWith("paseo-pi-mcp-")) dirs.push(join(tmp, entry));
		}
	} catch {
		return undefined;
	}
	// newest first by mtime of the config file
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
			// Exact-match the config provisioned for THIS agent: the daemon
			// embeds callerAgentId in the URL, so concurrent agents never cross
			// tokens. Fall back to newest only when self-id is unknown.
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

function statTime(p: string): number {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

export interface SpawnRequest {
	provider: string;
	title: string;
	labels: Record<string, string>;
	initialPrompt: string;
	thinkingOptionId: string;
}

export interface SpawnResult {
	ok: boolean;
	agentId?: string;
	status?: string;
	error?: string;
}

/** Create an agent over the MCP endpoint (JSON-RPC tools/call create_agent). */
export async function createAgent(req: SpawnRequest, endpoint: McpEndpoint): Promise<SpawnResult> {
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "create_agent",
			arguments: {
				provider: req.provider,
				title: req.title,
				labels: req.labels,
				initialPrompt: req.initialPrompt,
				notifyOnFinish: true,
				settings: { thinkingOptionId: req.thinkingOptionId },
			},
		},
	};
	try {
		const res = await fetch(endpoint.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${endpoint.token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		// SSE frame: lines starting with "data: "
		let payload: unknown;
		for (const line of text.split("\n")) {
			if (line.startsWith("data: ")) {
				try {
					payload = JSON.parse(line.slice(6));
				} catch {
					// keep last good
				}
			}
		}
		if (!payload) return { ok: false, error: `no MCP response (http ${res.status})` };
		const result = (payload as { result?: { isError?: boolean; structuredContent?: { agentId?: string; status?: string }; content?: Array<{ text?: string }> } }).result;
		if (result?.isError) {
			const detail = result.content?.[0]?.text ?? "create_agent failed";
			return { ok: false, error: detail.slice(0, 300) };
		}
		const sc = result?.structuredContent ?? {};
		return { ok: true, agentId: sc.agentId, status: sc.status };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
