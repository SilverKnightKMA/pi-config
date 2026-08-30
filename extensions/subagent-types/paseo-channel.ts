/**
 * Two-way messaging channel between main agent and its subagents.
 *
 * Delivery model (port of interactive-subagents semantics onto Paseo infra):
 *
 *   CHILD → MAIN  (sendToMain):      never interrupts the main agent. If the
 *   main is mid-run the message is appended to a persistent file queue keyed
 *   by the main's agent id; the MAIN-side drain (wired in index.ts to
 *   turn_end / before_agent_start / agent_settled) picks it up at the next
 *   turn boundary and injects it via pi.sendMessage. If the main is idle the
 *   message is delivered directly as a new turn (steer-back). One status
 *   check per send — no polling loop (the old 5s poll pinned the parent's
 *   daemon liveness window and messages never flushed).
 *
 *   MAIN → CHILD  (sendToSubagent):  turn-boundary pickup by default — busy
 *   child gets the message appended to its queue, delivered by its own drain
 *   at the next turn boundary (no interrupt). Idle child gets a new turn via
 *   send_agent_prompt (this is also the resume path for parked sessions).
 *   `interrupt: true` opts into the old urgent behaviour: the daemon
 *   interrupts-and-replaces the busy child's turn immediately.
 *
 * The queue is append-only JSONL at <piDataDir>/subagent-channel/<agentId>.jsonl
 * — persistent across restarts, so nothing is lost if a process dies with
 * undelivered messages.
 */

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { statSync } from "node:fs";

export interface McpEndpoint {
	url: string;
	token: string;
}

/** Locate the MCP config provisioned for callerAgentId (exact match, no cross-agent token use). */
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

function statTime(p: string): number {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

let callSeq = 0;

/** Low-level MCP JSON-RPC tools/call over the loopback endpoint. */
async function mcpCall(endpoint: McpEndpoint, tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<{ ok: boolean; data?: unknown; error?: string }> {
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
		const res = await fetch(endpoint.url, {
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

// ---------------------------------------------------------------------------
// Shared: create_agent (spawn)
// ---------------------------------------------------------------------------

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

export async function createAgent(req: SpawnRequest, endpoint: McpEndpoint): Promise<SpawnResult> {
	const r = await mcpCall(endpoint, "create_agent", {
		provider: req.provider,
		title: req.title,
		labels: req.labels,
		initialPrompt: req.initialPrompt,
		notifyOnFinish: true,
		settings: { thinkingOptionId: req.thinkingOptionId },
	});
	if (!r.ok) return { ok: false, error: r.error };
	const sc = (r.data as { agentId?: string; status?: string }) ?? {};
	return { ok: true, agentId: sc.agentId, status: sc.status };
}

// ---------------------------------------------------------------------------
// File queue (persistent, cross-process, no daemon involvement)
// ---------------------------------------------------------------------------

export interface ChannelMessage {
	id: string;
	from: string;
	fromRole: string;
	text: string;
	ts: string;
	/** "message" | "ask" | "reply" — ask/reply reserved for Phase 2 ask_question. */
	kind?: string;
}

/** Default queue root: <pi data dir>/subagent-channel/<agentId>.jsonl */
export function channelDir(base?: string): string {
	return join(base ?? join(homedir(), ".pi", "agent"), "subagent-channel");
}

export function queueFile(agentId: string, base?: string): string {
	return join(channelDir(base), `${agentId}.jsonl`);
}

/** Append one message to the target's queue. Append-only, crash-safe. */
export function pushToQueue(targetAgentId: string, msg: ChannelMessage, base?: string): void {
	const file = queueFile(targetAgentId, base);
	mkdirSync(channelDir(base), { recursive: true });
	appendFileSync(file, JSON.stringify(msg) + "\n", { encoding: "utf-8" });
}

/**
 * Atomically take ALL pending messages for targetAgentId.
 *
 * Rename-based: the live file is renamed aside first, then read. A writer
 * that appends after the rename re-creates a fresh file (appendFileSync
 * opens-writes-closes per call), so nothing is lost; a writer mid-flight on
 * the old inode lands in the renamed file, which we read. Multiple drains
 * are safe — second caller finds no file and returns [].
 */
export function drainQueue(targetAgentId: string, base?: string): ChannelMessage[] {
	const live = queueFile(targetAgentId, base);
	if (!existsSync(live)) return [];
	const aside = `${live}.draining-${process.pid}-${Date.now()}`;
	try {
		renameSync(live, aside);
	} catch {
		return []; // concurrent drain won the race
	}
	const out: ChannelMessage[] = [];
	try {
		for (const line of readFileSync(aside, "utf-8").split("\n")) {
			const s = line.trim();
			if (!s) continue;
			try {
				out.push(JSON.parse(s) as ChannelMessage);
			} catch {
				// torn tail line from a crash — drop it (next push re-appends cleanly)
			}
		}
	} finally {
		try {
			unlinkSync(aside);
		} catch {
			// best effort cleanup
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Status helpers (single calls — never loops)
// ---------------------------------------------------------------------------

interface AgentStatusResult {
	ok: boolean;
	status?: string; // running | idle | error | ...
	error?: string;
}

async function getAgentStatus(endpoint: McpEndpoint, agentId: string): Promise<AgentStatusResult> {
	const r = await mcpCall(endpoint, "get_agent_status", { agentId });
	if (!r.ok) return { ok: false, error: r.error };
	const sc = (r.data as { status?: string; snapshot?: { lastStatus?: string } }) ?? {};
	return { ok: true, status: sc.status ?? sc.snapshot?.lastStatus };
}

function isBusy(status: string | undefined): boolean {
	return status === "running" || status === "initializing";
}

// ---------------------------------------------------------------------------
// Send paths
// ---------------------------------------------------------------------------

export interface SendResult {
	ok: boolean;
	delivered?: "now" | "queued";
	error?: string;
}

/**
 * CHILD → MAIN. Never interrupts. One status check, then:
 *   busy/unknown → persistent file queue (drained by the main's own
 *                 turn_end / before_agent_start / agent_settled handlers)
 *   idle         → direct send_agent_prompt (steer-back as a new turn)
 * No polling loop — the poll loop was the bug (it pinned the parent's
 * liveness window and messages sat for 30+ minutes).
 */
export async function sendToMain(endpoint: McpEndpoint, mainAgentId: string, msg: ChannelMessage): Promise<SendResult> {
	const st = await getAgentStatus(endpoint, mainAgentId);
	if (st.ok && !isBusy(st.status)) {
		const rendered = renderForPrompt([msg]);
		const r = await mcpCall(endpoint, "send_agent_prompt", { agentId: mainAgentId, prompt: rendered, background: true, notifyOnFinish: false });
		if (r.ok) return { ok: true, delivered: "now" };
		// fall through to queue on transient failure — never lose the message
	}
	pushToQueue(mainAgentId, msg);
	return { ok: true, delivered: "queued" };
}

/**
 * MAIN → CHILD. Turn-boundary pickup by default:
 *   busy → file queue (child's own drain delivers at its next turn boundary)
 *   idle → direct send_agent_prompt (resume / new turn)
 * `interrupt: true` → always direct daemon send: busy child is
 * interrupted-and-replaced (urgent course change; opt-in only).
 */
export async function sendToSubagent(endpoint: McpEndpoint, agentId: string, msg: ChannelMessage, opts?: { interrupt?: boolean }): Promise<SendResult> {
	if (opts?.interrupt) {
		const r = await mcpCall(endpoint, "send_agent_prompt", { agentId, prompt: renderForPrompt([msg]), background: true, notifyOnFinish: true });
		return r.ok ? { ok: true, delivered: "now" } : { ok: false, error: r.error };
	}
	const st = await getAgentStatus(endpoint, agentId);
	if (st.ok && !isBusy(st.status)) {
		const r = await mcpCall(endpoint, "send_agent_prompt", { agentId, prompt: renderForPrompt([msg]), background: true, notifyOnFinish: true });
		if (r.ok) return { ok: true, delivered: "now" };
		// fall through to queue on transient failure
	}
	pushToQueue(agentId, msg);
	return { ok: true, delivered: "queued" };
}

/** Render queue entries as prompt-visible subagent-message blocks. */
export function renderForPrompt(msgs: ChannelMessage[]): string {
	return msgs
		.map((m) => `<subagent-message from="${m.from}" role="${m.fromRole}" kind="${m.kind ?? "message"}">\n${m.text}\n</subagent-message>`)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Phase 2: name registry + ask/wait (interactive-subagents semantics)
// ---------------------------------------------------------------------------

export interface RegistryEntry {
	agentId: string;
	role: string;
	title?: string;
	createdAt: string;
}

function registryFile(base?: string): string {
	return join(channelDir(base), "registry.json");
}

/** Load name → latest spawn record. Corrupt file → empty registry (not fatal). */
export function loadRegistry(base?: string): Record<string, RegistryEntry> {
	try {
		return JSON.parse(readFileSync(registryFile(base), "utf-8"));
	} catch {
		return {};
	}
}

export function saveRegistry(entries: Record<string, RegistryEntry>, base?: string): void {
	mkdirSync(channelDir(base), { recursive: true });
	const tmp = `${registryFile(base)}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(entries, null, "\t"));
	renameSync(tmp, registryFile(base));
}

/** Record a spawn. Same name re-spawned → latest wins. */
export function registerSubagent(name: string, entry: RegistryEntry, base?: string): void {
	const entries = loadRegistry(base);
	entries[name] = entry;
	saveRegistry(entries, base);
}

export function resolveSubagentName(name: string, base?: string): RegistryEntry | undefined {
	return loadRegistry(base)[name];
}

/**
 * Ask-side wait: poll the CALLER'S OWN queue file for any incoming message
 * (kind "reply" from the main, or "message" — a redirect counts too).
 * Purely local file reads — zero daemon traffic, nothing pins any liveness
 * window. Resolves as soon as an entry lands, or undefined on timeout.
 * Safe against the 3-event drains: no turn boundary can occur while a tool
 * call is executing.
 */
export async function waitForReply(
	selfAgentId: string,
	timeoutMs: number,
	base?: string,
	pollMs = 2_000,
): Promise<ChannelMessage | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const got = drainQueue(selfAgentId, base);
		if (got.length > 0) return got[0];
		if (Date.now() >= deadline) return undefined;
		await new Promise((r) => setTimeout(r, Math.min(pollMs, deadline - Date.now())));
	}
}
