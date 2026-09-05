/**
 * sse-probe — provider stream-drop detector (observer only, 2026-09-05).
 *
 * Hypothesis under test: the zaicp proxy route (cli-openai/zaicp/glm-*) cuts
 * the SSE stream mid-turn, which surfaces in pi as an AssistantMessage with
 * stopReason "error"/"aborted" and errorMessage "This operation was aborted"
 * (OpenAI SDK AbortError), followed by daemon-side turn_failed. This probe
 * LOGS every such occurrence with evidence — it never acts, never emits to
 * the timeline (v2 emission policy), and never touches the turn.
 *
 * Outputs (user-wide, outside any workspace):
 *   ~/.pi/agent/sse-probe.jsonl  — one JSON line per occurrence (append-only)
 *   ~/.pi/agent/sse-probe.json   — rolling summary for a future panel/plugin
 *
 * Verification method: the user knows when they pressed STOP. A drop they
 * did NOT cause — mid-turn, after content had already streamed — is the
 * zaicp signature. Correlate by timestamp.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function probePaths(): { jsonl: string; summary: string } {
	const home = process.env.PI_HOME ?? process.env.HOME ?? "/home/coder";
	return {
		jsonl: join(home, ".pi", "agent", "sse-probe.jsonl"),
		summary: join(home, ".pi", "agent", "sse-probe.json"),
	};
}

/** Provider substrings we suspect of SSE cuts (labeling only — we log everything). */
const SUSPECT_PROVIDERS = ["zaicp"];

export interface ProbeRecord {
	ts: string;
	sessionId: string;
	turnIndex: number;
	provider: string;
	model: string;
	stopReason: string;
	/** heuristic label — see classify() */
	kind: string;
	errorMessage: string;
	/** ms the turn ran before the drop (0 when turn_start was not seen) */
	turnDurMs: number;
	/** assistant chars streamed before the cut (>0 mid-turn = model was responding) */
	contentLen: number;
	/** toolCall id of the last pending tool call in the partial message, if any */
	lastToolCall: string | null;
}

export interface ProbeSummary {
	total: number;
	byKind: Record<string, number>;
	/** occurrences in the 24h before the summary was written */
	last24h: number;
	lastTs: string | null;
	last: ProbeRecord | null;
}

export function truncate(s: string, max = 200): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Heuristic classification (labels, not verdicts):
 *  - "suspect-sse-drop"   — abort/error on a suspect provider, mid-turn content
 *  - "abort-no-content"   — abort/error before any content streamed
 *  - "provider-error"     — non-abort error (HTTP 4xx/5xx, quota, …)
 *  - "user-stop-lookalike"— abort with no errorMessage (pi user-abort shape)
 */
export function classify(input: {
	provider: string;
	model?: string;
	stopReason: string;
	errorMessage: string;
	contentLen: number;
}): string {
	// "zaicp" shows up in the MODEL id (cli-openai provider, model "zaicp/glm-*"),
	// so both fields are checked.
	const hay = `${input.provider} ${input.model ?? ""}`;
	const suspect = SUSPECT_PROVIDERS.some((p) => hay.includes(p));
	const abort = input.stopReason === "aborted" || /abort/i.test(input.errorMessage);
	if (abort && !input.errorMessage) return "user-stop-lookalike";
	if (abort && suspect && input.contentLen > 0) return "suspect-sse-drop";
	if (abort) return "abort-no-content";
	return "provider-error";
}

export function buildRecord(input: {
	sessionId: string;
	turnIndex: number;
	provider: string;
	model: string;
	stopReason: string;
	errorMessage: string;
	turnStartedAt: number | null;
	now: number;
	contentLen: number;
	lastToolCall: string | null;
}): ProbeRecord {
	return {
		ts: new Date(input.now).toISOString(),
		sessionId: input.sessionId,
		turnIndex: input.turnIndex,
		provider: input.provider,
		model: input.model,
		stopReason: input.stopReason,
		kind: classify({
			provider: input.provider,
			model: input.model,
			stopReason: input.stopReason,
			errorMessage: input.errorMessage,
			contentLen: input.contentLen,
		}),
		errorMessage: truncate(input.errorMessage),
		turnDurMs: input.turnStartedAt ? input.now - input.turnStartedAt : 0,
		contentLen: input.contentLen,
		lastToolCall: input.lastToolCall,
	};
}

export function updateSummary(prev: ProbeSummary | null, rec: ProbeRecord, now: number): ProbeSummary {
	const base: ProbeSummary = prev ?? { total: 0, byKind: {}, last24h: 0, lastTs: null, last: null };
	return {
		total: base.total + 1,
		byKind: { ...base.byKind, [rec.kind]: (base.byKind[rec.kind] ?? 0) + 1 },
		last24h: (base.last24h ?? 0) + 1,
		lastTs: rec.ts,
		last: rec,
	};
}

/** Text length of a partial assistant message (strong mid-turn signal). */
function contentLength(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const part of content as Array<{ type?: string; text?: string }>) {
		if (part?.type === "text" && typeof part.text === "string") n += part.text.length;
	}
	return n;
}

function lastToolCallOf(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	for (const part of [...(content as Array<{ type?: string; name?: string; id?: string }>)].reverse()) {
		if (part?.type === "toolCall" && typeof part.id === "string") return part.id;
	}
	return null;
}

export default function sseProbe(pi: ExtensionAPI) {
	let sessionId = "";
	let turnStartedAt: number | null = null;
	// MessageEndEvent carries NO turnIndex (verified against pi 0.84.4
	// types.d.ts) — capture it from turn_start instead, and dedupe by the
	// message id. Deduping by a nonexistent turnIndex (-1 === -1) silently
	// swallowed EVERY record — the 2026-09-05 16:55Z/16:57Z zaicp drops
	// were logged nowhere. Regression: the fake pi below fires message_end
	// WITHOUT turnIndex and expects a record.
	let currentTurnIndex = -1;
	let lastLoggedMsgId: string | null = null;

	function writeAll(rec: ProbeRecord): void {
		try {
			const { jsonl, summary } = probePaths();
			mkdirSync(dirname(jsonl), { recursive: true });
			appendFileSync(jsonl, `${JSON.stringify(rec)}\n`, "utf8");
			let prev: ProbeSummary | null = null;
			try {
				prev = JSON.parse(readFileSync(summary, "utf8")) as ProbeSummary;
			} catch {
				prev = null;
			}
			const next = updateSummary(prev && typeof prev.total === "number" ? prev : null, rec, Date.now());
			const tmp = `${summary}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify(next), "utf8");
			renameSync(tmp, summary);
		} catch {
			// observer: never let logging break a turn
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionId = (ctx.sessionManager.getSessionId?.() as string | undefined) ?? "";
	});

	pi.on("turn_start", (event) => {
		turnStartedAt = Date.now();
		if (typeof event.turnIndex === "number") currentTurnIndex = event.turnIndex;
	});

	// message_end is the reliable hook: a stream cut still finalizes the
	// partial AssistantMessage with stopReason error/aborted + errorMessage,
	// while turn_end may not fire for failed turns at all.
	pi.on("message_end", (event) => {
		const m = event.message as
			| {
						id?: string;
					role?: string;
					provider?: string;
					model?: string;
					stopReason?: string;
					errorMessage?: string;
					content?: unknown;
			  }
			| undefined;
		if (!m || m.role !== "assistant") return;
		const stopReason = m.stopReason ?? "";
		if (stopReason !== "error" && stopReason !== "aborted") return;
		const msgId = typeof m.id === "string" ? m.id : "";
		if (msgId && msgId === lastLoggedMsgId) return; // same message twice
		lastLoggedMsgId = msgId || null;
		writeAll(
			buildRecord({
				sessionId,
				turnIndex: currentTurnIndex,
				provider: m.provider ?? "unknown",
				model: m.model ?? "unknown",
				stopReason,
				errorMessage: m.errorMessage ?? "",
				turnStartedAt,
				now: Date.now(),
				contentLen: contentLength(m.content),
				lastToolCall: lastToolCallOf(m.content),
			}),
		);
	});
}
