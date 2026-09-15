/**
 * Layer-2 judge: independent LLM verification of task completion.
 *
 * Design provenance (settled with the user 2026-09-09, see
 * learn/pify-pending-2026-09-07.md row 9):
 * - judge model MUST come from a different family than the worker (worker
 *   runs GLM via zaicp; default judge fci/deepseek-v4-flash — user decision
 *   2026-09-09; override via env TASK_JUDGE_MODEL or settings taskJudgeModel)
 * - judges by DONE-CHECK intent, not by probes — may rule "work done + probe
 *   wrong" on a spec-fault (amber) escalation
 * - consequences: pass → completed; high-confidence fail ×2 consecutive →
 *   demote in_progress with the reason delivered to the worker; low
 *   confidence → ask for more evidence, no demotion; appeal → PARK; 3 judge
 *   rounds without completion → PARK
 * - fail-closed on judge unavailability (user decision 2026-09-09): completion
 *   is refused until the judge runs; the escape valve is appeal → PARK
 * - cited_log_ids is a forcing function: the judge must cite log lines that
 *   exist in the packet; out-of-range citations invalidate the verdict
 *   (research: False Success ICML 2026 + llm-as-judge brief 2026-09-09)
 *
 * Pure module — no pi/fs/clock imports; the subprocess runner lives in
 * index.ts and is injectable for tests.
 */
import { isRecord, type DescAmendment } from "./types.ts";

export interface LogSliceEntry {
	cmd: string;
	output: string;
	/** epoch ms when the command ran — printed in the packet so the judge can
	 * order entries by TIME, not by packet position (2026-09-15 incident: a
	 * mid-development failing run listed after a newer green run read as
	 * "later log lines show a failing test"). */
	ts?: number;
}

export interface JudgeProbeView {
	pattern: string;
	expect?: string;
	status: "green" | "amber" | "red";
	observed?: string;
}

export interface JudgePacketInput {
	subject: string;
	/** Done-check: the acceptance criteria (task description). */
	doneCheck: string;
	/** Worker's evidence claim (level-1 testimony). */
	evidence: string;
	lane: "state" | "judgment";
	probes?: JudgeProbeView[];
	/** v1.4.38: doneCheck rewrite trail. The judge only ever sees the CURRENT
	 * sheet — without this it cannot know the worker rephrased the question.
	 * Self-serving rewrites right before completion deserve heavier scrutiny. */
	descHistory?: DescAmendment[];
	/** v1.4.76: the FULL run log (pre-slice) so PATTERN HISTORY can report
	 * matching runs the cap cut out. When omitted, no history section. */
	fullLog?: LogSliceEntry[];
}

export const MAX_LOG_SLICE = 20;
export const MAX_JUDGE_ROUNDS = 3;

/** Pick the log lines the judge sees. v1.4.76 contract (2026-09-15 incident,
 * 5 falsely-held plan steps): the slice is NEWEST-FIRST everywhere — relevant
 * entries first but ordered newest→oldest, then newest non-matching context.
 * Rationale: verdict value concentrates in the newest run of a pattern; older
 * matching runs are mid-development history and must never appear AFTER a
 * newer run in packet order (the judge reads packet order as chronology). */
export function pickLogSlice(
	log: LogSliceEntry[],
	probes: JudgeProbeView[],
	evidence: string,
	cap = MAX_LOG_SLICE,
): LogSliceEntry[] {
	const patterns = probes.map((p) => p.pattern).filter((p) => p.length >= 3);
	const claims: string[] = [];
	for (const m of evidence.matchAll(/`([^`\n]{4,120})`/g)) claims.push(m[1]);
	const relevant = (e: LogSliceEntry) =>
		patterns.some((p) => e.cmd.includes(p)) || claims.some((c) => e.cmd.includes(c) || c.includes(e.cmd));
	const hits = log.filter(relevant).reverse(); // newest first
	const rest = log.filter((e) => !relevant(e)).reverse();
	const out: LogSliceEntry[] = [];
	for (const e of hits) {
		if (out.length >= cap) break;
		out.push(e);
	}
	for (const e of rest) {
		if (out.length >= cap) break;
		out.push(e);
	}
	return out;
}

export interface PatternHistoryLine {
	pattern: string;
	matched: number;
	/** times (epoch ms) of matching runs included in the slice */
	included: number[];
	/** times (epoch ms) of older matching runs cut by the cap */
	older: number[];
}

/** Per probe-pattern run history: tells the judge how many runs matched a
 * pattern and that older ones exist but are superseded by the newest — so a
 * stale mid-development failure cannot masquerade as the final state. */
export function patternHistory(
	log: LogSliceEntry[],
	probes: JudgeProbeView[],
	included: LogSliceEntry[],
): PatternHistoryLine[] {
	const includedTs = new Set(included.filter((e) => e.ts !== undefined).map((e) => e.ts as number));
	const out: PatternHistoryLine[] = [];
	for (const p of probes) {
		if (p.pattern.length < 3) continue;
		const times = log
			.filter((e) => e.cmd.includes(p.pattern) && e.ts !== undefined)
			.map((e) => e.ts as number)
			.sort((a, b) => b - a); // newest first
		if (times.length < 2) continue; // single run: nothing to contextualize
		out.push({
			pattern: p.pattern,
			matched: times.length,
			included: times.filter((t) => includedTs.has(t)),
			older: times.filter((t) => !includedTs.has(t)),
		});
	}
	return out;
}

function fmtTs(ts: number | undefined): string {
	return ts === undefined ? "" : ` ${new Date(ts).toISOString().slice(11, 19)}Z`;
}

/** Render the TAIL of an output: verdict lines of suites/logs live at the
 * end ("0 fail", "ALL 14 EXTENSIONS LOAD CLEAN", exit codes). The old
 * head-cut hid them behind the first 3 lines and judges ruled "truncated /
 * cannot confirm" (2026-09-15 incident, same shape as the v1.4.74 loop-guard
 * head-window false kill). */
function renderTail(output: string): string {
	if (!output) return "";
	const lines = output.split("\n").filter((l) => l.trim() !== "");
	if (lines.length === 0) return "";
	return lines.slice(-3).join(" ⏎ ").slice(-300);
}

/** Build the judge packet: instructions + task + probes + evidence + numbered log. */
export function buildJudgePacket(input: JudgePacketInput, log: LogSliceEntry[]): string {
	const lines: string[] = [];
	lines.push(
		"You are an independent verifier for a coding-agent task. Judge ONLY from the material below — " +
			"the worker's evidence is a CLAIM, the LOG is what actually ran. Output a single JSON object, no prose:",
		'{"verdict":"pass|fail|insufficient_evidence","confidence":"high|medium|low","reason":"short","cited_log_ids":[0]}',
		"- pass: the done-check is met by the evidence and/or log",
		"- fail: clear signs the work is NOT done, or the evidence is fabricated",
		"- insufficient_evidence: you cannot tell from this material",
		"cited_log_ids reference LOG lines below (0-based) and MUST exist; fabricated ids invalidate your verdict.",
	);
	lines.push("## TASK");
	lines.push(`subject: ${input.subject}`);
	lines.push(`done-check: ${input.doneCheck || "(no explicit done-check — judge by subject intent)"}`);
	if (input.descHistory && input.descHistory.length > 0) {
		const agentRewrites = input.descHistory.filter((d) => d.by === "agent").length;
		lines.push("## DONE-CHECK AMENDMENTS (the worker rewrote the acceptance criteria)");
		lines.push(
			`The done-check above was rewritten ${input.descHistory.length} time(s), ${agentRewrites} by the worker itself. ` +
				"A rewrite that merely rephrases the criteria to match existing evidence is self-serving — weigh accordingly " +
				"(older criteria still bind unless the rewrite is justified by changed reality):",
		);
		for (const d of input.descHistory) {
			lines.push(`- (${d.by}) was: ${d.from || "(empty)"} -> now: ${d.to || "(empty)"}`);
		}
	}
	if (input.probes && input.probes.length > 0) {
		lines.push("## PROBES (deterministic layer-1 results)");
		for (const p of input.probes) {
			lines.push(
				`- [${p.status}] pattern=${JSON.stringify(p.pattern)}${p.expect ? ` expect=${JSON.stringify(p.expect)}` : ""}` +
					(p.observed !== undefined ? ` observed=${JSON.stringify(p.observed.slice(0, 200))}` : ""),
			);
		}
		lines.push("amber = the command ran but the expected output was absent — possibly a wrong probe spec, not worker fault.");
	}
	lines.push("## EVIDENCE (worker's claim — not proof)");
	lines.push(input.evidence || "(none provided)");
	lines.push(`## LOG (${log.length} lines, NEWEST FIRST — [0] is the most recent; timestamps HH:MM:SSZ)`);
	log.forEach((e, i) => {
		lines.push(`[${i}]${fmtTs(e.ts)} cmd: ${e.cmd}`);
		const tail = renderTail(e.output);
		if (tail) lines.push(`    out(tail): ${tail}`);
	});
	const hist = input.fullLog ? patternHistory(input.fullLog, input.probes ?? [], log) : [];
	if (hist.length > 0) {
		lines.push("## PATTERN HISTORY (same probe matched multiple runs)");
		lines.push(
			"Older runs are superseded by the newest unless the newest itself fails; mid-development failures commonly appear here.",
		);
		for (const h of hist) {
			const older = h.older.map((t) => new Date(t).toISOString().slice(11, 19) + "Z").join(", ");
			lines.push(`- "${h.pattern}": ${h.matched} matching runs — newest in LOG above; older not shown: ${older || "(all shown)"}`);
		}
	}
	return lines.join("\n");
}

export interface JudgeVerdict {
	verdict: "pass" | "fail" | "insufficient_evidence";
	confidence: "high" | "medium" | "low";
	reason: string;
	cited_log_ids: number[];
}

/** Extract the first balanced JSON object from raw model output; validate it.
 *  Out-of-range cited_log_ids invalidate the verdict (converted to
 *  insufficient_evidence/low — an unverifiable citation is no citation).
 *  Returns null when no parsable verdict exists. */
export function parseJudgeVerdict(raw: string, logCount: number): JudgeVerdict | null {
	const start = raw.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let end = -1;
	let inStr = false;
	let esc = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (ch === "\\") {
			if (inStr) esc = true;
			continue;
		}
		if (ch === '"') inStr = !inStr;
		else if (!inStr && ch === "{") depth++;
		else if (!inStr && ch === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!isRecord(obj)) return null;
	const verdict = obj.verdict;
	const confidence = obj.confidence;
	if (verdict !== "pass" && verdict !== "fail" && verdict !== "insufficient_evidence") return null;
	if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return null;
	const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 500) : "";
	const citedRaw = Array.isArray(obj.cited_log_ids) ? obj.cited_log_ids : [];
	const cited = citedRaw.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < logCount);
	const fabricated = citedRaw.length > cited.length;
	if (fabricated) {
		return {
			verdict: "insufficient_evidence",
			confidence: "low",
			reason: `judge cited ${citedRaw.length - cited.length} non-existent log id(s) — citation invalid, verdict untrusted. ${reason}`,
			cited_log_ids: cited,
		};
	}
	return { verdict, confidence, reason, cited_log_ids: cited };
}

export type JudgeAction =
	| "complete"
	| "demote"
	| "need-evidence"
	| "fail-streak"
	| "refuse-unavailable"
	| "park-cap";

export interface JudgeConsequence {
	action: JudgeAction;
	message: string;
	/** next failStreak / judgeRounds to persist on the task */
	failStreak: number;
	judgeRounds: number;
}

/** Map a verdict (or judge unavailability) to the consequence the tool layer
 *  applies. Streak counts CONSECUTIVE high-confidence fails; any non-high
 *  outcome resets it; the 3-round cap funnels everything to PARK. */
export function verdictConsequence(
	verdict: JudgeVerdict | null,
	prev: { failStreak: number; judgeRounds: number },
): JudgeConsequence {
	const rounds = prev.judgeRounds + 1;
	if (verdict === null) {
		return {
			action: "refuse-unavailable",
			message:
				"[layer-2] judge unavailable (spawn error/timeout/relay) — completion refused (fail-closed). " +
				"Try again later; if stuck for long, appeal (task_update appeal=\"reason\") to PARK and wait for the user.",
			failStreak: prev.failStreak,
			judgeRounds: prev.judgeRounds,
		};
	}
	if (rounds >= MAX_JUDGE_ROUNDS && verdict.verdict !== "pass") {
		return {
			action: "park-cap",
			message: `[layer-2] ${MAX_JUDGE_ROUNDS} judge rounds spent without completion — PARK awaiting the user. Last-round reason: ${verdict.reason}`,
			failStreak: prev.failStreak,
			judgeRounds: rounds,
		};
	}
	if (verdict.verdict === "pass") {
		return {
			action: "complete",
			message: `judge: PASS — ${verdict.reason}`,
			failStreak: 0,
			judgeRounds: rounds,
		};
	}
	if (verdict.verdict === "insufficient_evidence") {
		return {
			action: "need-evidence",
			message: `[layer-2] not enough evidence to rule (${verdict.confidence}) — ${verdict.reason}. Add concrete evidence (commands run, output, files), then declare completed again.`,
			failStreak: 0,
			judgeRounds: rounds,
		};
	}
	// verdict === "fail"
	if (verdict.confidence === "high") {
		const streak = prev.failStreak + 1;
		if (streak >= 2) {
			return {
				action: "demote",
				message: `[layer-2] judge rules FAIL (high conf) ${streak} consecutive times — demote to in_progress. Reason: ${verdict.reason}`,
				failStreak: 0,
				judgeRounds: rounds,
			};
		}
		return {
			action: "fail-streak",
			message: `[layer-2] judge rules FAIL (high conf, attempt ${streak}/2) — completion refused, no demote yet. Reason: ${verdict.reason}. Fix the work and re-declare; if you disagree, appeal.`,
			failStreak: streak,
			judgeRounds: rounds,
		};
	}
	return {
		action: "need-evidence",
		message: `[layer-2] judge rules FAIL but confidence ${verdict.confidence} — treated as insufficient evidence, no demotion. Reason: ${verdict.reason}. Add evidence, then re-declare.`,
		failStreak: 0,
		judgeRounds: rounds,
	};
}
