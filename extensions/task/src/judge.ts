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
import { isRecord } from "./types.ts";

export interface LogSliceEntry {
	cmd: string;
	output: string;
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
}

export const MAX_LOG_SLICE = 20;
export const MAX_JUDGE_ROUNDS = 3;

/** Pick the log lines the judge sees: probe/evidence-relevant first, then the
 *  newest entries as context — R1 (input caps quality) keeps the packet small. */
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
	const hits = log.filter(relevant);
	const rest = [...log].reverse().filter((e) => !relevant(e));
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
	lines.push(`## LOG (${log.length} lines, what actually ran)`);
	log.forEach((e, i) => {
		lines.push(`[${i}] cmd: ${e.cmd}`);
		if (e.output) lines.push(`    out: ${e.output.split("\n").slice(0, 3).join(" ⏎ ").slice(0, 300)}`);
	});
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
				"[layer-2] judge KHÔNG khả dụng (spawn lỗi/timeout/relay) — completion bị từ chối (fail-closed). " +
				"Thử lại sau; nếu kẹt lâu thì appeal (task_update appeal=\"lý do\") để PARK chờ user.",
			failStreak: prev.failStreak,
			judgeRounds: prev.judgeRounds,
		};
	}
	if (rounds >= MAX_JUDGE_ROUNDS && verdict.verdict !== "pass") {
		return {
			action: "park-cap",
			message: `[layer-2] đủ ${MAX_JUDGE_ROUNDS} vòng phán mà chưa xong — PARK chờ user. Lý do vòng cuối: ${verdict.reason}`,
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
			message: `[layer-2] chưa đủ bằng chứng để phán (${verdict.confidence}) — ${verdict.reason}. Bổ sung evidence cụ thể (lệnh đã chạy, output, file) rồi khai completed lại.`,
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
				message: `[layer-2] judge phán FAIL (conf cao) ${streak} lần liên tiếp — demote về in_progress. Lý do: ${verdict.reason}`,
				failStreak: 0,
				judgeRounds: rounds,
			};
		}
		return {
			action: "fail-streak",
			message: `[layer-2] judge phán FAIL (conf cao, lần ${streak}/2) — completion từ chối, chưa demote. Lý do: ${verdict.reason}. Sửa việc rồi khai lại; không đồng ý thì appeal.`,
			failStreak: streak,
			judgeRounds: rounds,
		};
	}
	return {
		action: "need-evidence",
		message: `[layer-2] judge phán FAIL nhưng conf ${verdict.confidence} — xử như thiếu bằng chứng, không demote. Lý do: ${verdict.reason}. Bổ sung evidence rồi khai lại.`,
		failStreak: 0,
		judgeRounds: rounds,
	};
}
