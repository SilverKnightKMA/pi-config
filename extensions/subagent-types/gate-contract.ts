/**
 * gate-contract.ts — honest outcomes for delegated work (port @pify/swarm 0.12.1,
 * batch #294 P5; result-contract vocabulary credited to FradSer/pi-monitor).
 *
 * Three separations this module enforces:
 *
 * 1. "It finished" ≠ "it worked". RunStatus says whether the child session ran;
 *    TaskOutcome says what the task came to. A polite report explaining a wall
 *    must not read the same as a shipped feature.
 * 2. A claim is not evidence, and evidence outranks claims. A gate that ran and
 *    failed beats a child's "went fine"; a gate that proved nothing either way
 *    (result_missing / no_attestation) is NOT a failure of the work — reporting
 *    it as one sends the reader hunting a bug in the work for a typo in the gate.
 *    (Same lesson as our verify-layer: exit 0 without evidence proves nothing.)
 * 3. Repair is only worth spending on someone who can write AND did not declare
 *    itself blocked. A read-only child can only re-read the failure; a child
 *    that said OUTCOME: blocked has stated the wall is outside its reach.
 *
 * Drift-guard (#294): pure, dependency-free, separate module — spawn_pool wiring
 * untouched. The command-running side of upstream's gate stays with our existing
 * owner (task verify layer probes); what lands here is the CONTRACT and the
 * outcome algebra so any verifier can speak it.
 */

// ── outcome.ts (upstream, adapted) ─────────────────────────────────────────

/** What the delegated task actually came to. */
export type TaskOutcome = "succeeded" | "blocked" | "failed";

/** How well that outcome is known. Orthogonal to the outcome itself. */
export type Verification = "not-requested" | "passed" | "failed" | "inconclusive";

/** What a finished gate proved about the work. */
export type GateOutcome = "success" | "failure" | "result_missing" | "timeout" | "no_attestation";

/** The marker a child may end its report with to declare its own outcome. */
const DECLARATION = /^\s*outcome:\s*(succeeded|blocked|failed)\s*$/gim;

/**
 * Read a child's self-declared outcome, if it made one. Last declaration wins:
 * a report that revises itself means the later line. This is a *claim*, not
 * evidence — the value is that it is parseable, and that a blocked child can
 * say so in one place instead of burying it in prose. Absent or unparseable
 * means "no claim", never a failure.
 */
export function parseDeclaredOutcome(text: string | null | undefined): TaskOutcome | undefined {
	if (!text) return undefined;
	let found: TaskOutcome | undefined;
	DECLARATION.lastIndex = 0;
	for (const m of text.matchAll(DECLARATION)) found = m[1]!.toLowerCase() as TaskOutcome;
	return found;
}

/** Strip the declaration line so it does not also show up in the report body. */
export function stripDeclaration(text: string): string {
	return text.replace(DECLARATION, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Translate a gate outcome into verification terms. */
export function gateVerification(outcome: GateOutcome): Verification {
	if (outcome === "success") return "passed";
	if (outcome === "failure" || outcome === "timeout") return "failed";
	// result_missing and no_attestation both mean the gate settled without
	// establishing anything — not a verdict against the work.
	return "inconclusive";
}

export interface OutcomeInput {
	/** Lifecycle: did the session itself run to the end? */
	status: "running" | "done" | "error" | "aborted";
	/** The child's own claim, when it made one. */
	declared?: TaskOutcome;
	/** What the gate proved, when one ran. */
	verification?: Verification;
}

/**
 * Settle the task outcome from the facts, most authoritative first:
 * a session that did not finish cannot have succeeded; a gate that failed
 * outranks any claim; then the child's own claim; then success by default.
 */
export function deriveOutcome(input: OutcomeInput): TaskOutcome {
	if (input.status !== "done") return "failed";
	if (input.verification === "failed") return "failed";
	if (input.declared) return input.declared;
	return "succeeded";
}

/** One line for the report, naming both facts. */
export function outcomeLine(outcome: TaskOutcome, verification: Verification): string {
	const how =
		verification === "not-requested"
			? "no gate was requested, so this is the agent's own account"
			: verification === "passed"
				? "a gate ran and passed"
				: verification === "failed"
					? "a gate ran and failed"
					: "a gate ran but proved nothing either way";
	return `[outcome] ${outcome} — ${how}`;
}

// ── gate.ts contract side (upstream, adapted; no runner — see header) ──────

export interface GateContract {
	/** The command to run. */
	command: string;
	/** Regex source: success requires a match in the combined output. */
	expect?: string;
	/** Regex source: a match means failure even when the command exits 0. */
	failure?: string;
	timeoutMs?: number;
}

export interface GateRun {
	/** Exit status, or null when the process was killed (timeout/signal). */
	status: number | null;
	/** Signal that killed it, when one did. */
	signal?: string | null;
	output: string;
	/** True when the runner stopped it at the timeout. */
	timedOut?: boolean;
	/** The command never became a process. Not a verdict on the work. */
	spawnError?: string;
}

export interface GateVerdict {
	outcome: GateOutcome;
	ok: boolean;
	/** One line for the run log, in this package's words. */
	reason: string;
}

function compile(source: string | undefined): RegExp | null {
	if (!source) return null;
	try {
		return new RegExp(source, "m");
	} catch {
		return null;
	}
}

/**
 * Judge a finished gate run. Order matters: a spawn error attests nothing, a
 * timeout is a real verdict, an explicit failure pattern beats a zero exit,
 * and a missing success pattern is never a pass — exit 0 without the expected
 * evidence is `result_missing`, its own outcome, not a success.
 */
export function evaluateGate(contract: GateContract, run: GateRun): GateVerdict {
	if (run.spawnError) {
		return {
			outcome: "no_attestation",
			ok: false,
			reason: `gate never ran (${run.spawnError}) — nothing was proved either way`,
		};
	}
	if (run.timedOut || (run.status === null && run.signal)) {
		return {
			outcome: "timeout",
			ok: false,
			reason: `gate timed out after ${contract.timeoutMs ?? "the default"}ms`,
		};
	}
	if (run.status === null) {
		return {
			outcome: "no_attestation",
			ok: false,
			reason: "gate produced no exit status — nothing was proved either way",
		};
	}
	const failurePattern = compile(contract.failure);
	if (failurePattern && failurePattern.test(run.output)) {
		return {
			outcome: "failure",
			ok: false,
			reason: `gate output matched its failure pattern /${contract.failure}/`,
		};
	}
	if (run.status !== 0) {
		return { outcome: "failure", ok: false, reason: `gate exited ${run.status}` };
	}
	const expectPattern = compile(contract.expect);
	if (expectPattern && !expectPattern.test(run.output)) {
		return {
			outcome: "result_missing",
			ok: false,
			reason: `gate exited 0 but its output never matched /${contract.expect}/ — nothing was verified`,
		};
	}
	return {
		outcome: "success",
		ok: true,
		reason: expectPattern ? `gate passed and matched /${contract.expect}/` : "gate exited 0",
	};
}

/** An unparseable pattern is a broken contract, not a passing one. */
export function contractProblems(contract: GateContract): string[] {
	const problems: string[] = [];
	if (!contract.command.trim()) problems.push("gate has no command");
	for (const [field, source] of [
		["expect", contract.expect],
		["failure", contract.failure],
	] as const) {
		if (source && !compile(source)) problems.push(`gate ${field} is not a valid regular expression`);
	}
	if (contract.timeoutMs !== undefined && !(contract.timeoutMs > 0)) {
		problems.push("gate timeoutMs must be positive");
	}
	return problems;
}

// ── repair-policy.ts (upstream, adapted) ───────────────────────────────────

/** An agent that can write is one that can fix what a gate complained about. */
export function canWrite(tools: readonly string[]): boolean {
	return tools.some((t) => t === "edit" || t === "write" || t === "bash" || t === "powershell");
}

/**
 * May this item be sent on a repair pass, given the agent's tools and what it
 * said? A read-only agent can only re-read the failure; a child that declared
 * OUTCOME: blocked has said the wall is outside its reach — a repair pass
 * would just re-discover it at the cost of a full child run.
 */
export function repairAllowed(tools: readonly string[], result: string | null | undefined): boolean {
	return canWrite(tools) && parseDeclaredOutcome(result) !== "blocked";
}
