/**
 * bash-long-run-guard — pure matcher (v1.4.71, 2026-09-15).
 *
 * Recurring incident class (user complaints 2026-09-05 + 2026-09-15: "why
 * does this keep failing?" / "another error?" / "this repeats too often"): the Paseo↔pi tool
 * channel intermittently aborts in-flight SILENT bash calls a few seconds in —
 * tool result becomes `Command aborted` even though the underlying work
 * completed. Daemon restarts do NOT fix it (channel-level, not daemon-level).
 *
 * The manual fix (memory user-preferences "silent-bash-abort pattern"):
 * route anything non-trivial through the background pattern UP FRONT:
 *   L=/tmp/blk-$RANDOM$RANDOM.log; setsid nohup bash -c '<cmd>; echo EXIT:$?' \
 *     >$L 2>&1 </dev/null & sleep 1; tail -5 $L
 *
 * This module decides, deterministically and model-free, whether a bash
 * command is in the abort-risk class and NOT already backgrounded.
 */
export interface BashLongRunVerdict {
	/** true → command is in the risk class and runs foreground → the engine blocks it. */
	background: boolean;
	/** human-language WHY (denial envelope #43). */
	reason?: string;
	/** exact recipe the caller should run instead. */
	recipe?: string;
}

/** Silent, multi-second, output-at-the-end commands — the observed abort class.
 *  Chatty/streaming commands (git push, node scripts with progress, curl) have
 *  NOT aborted and stay out of the list (scope discipline). */
const RISK_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /\bbun\s+(test|run\s+test)\b/, label: "bun test (suite)" },
	{ re: /\bnpm\s+(test|run\s+test)\b/, label: "npm test" },
	{ re: /\byarn\s+test\b/, label: "yarn test" },
	{ re: /\bbun\s+install\b/, label: "bun install" },
	{ re: /\bnpm\s+(ci|install)\b/, label: "npm install" },
	{ re: /\bsleep\s+(?:[3-9]|[1-9]\d+)\b/, label: "foreground sleep ≥3s" },
	{ re: /\bfor\s+\w+\s+in\b[^\n]*\bsleep\b/, label: "polling for-loop with sleep" },
	{ re: /\bwhile\b[^\n]*\bsleep\b/, label: "while-loop with sleep" },
	{ re: /\bseq\s+\d+\b[^\n]*\bsleep\b/, label: "seq polling loop with sleep" },
	{ re: /\bgh\s+pr\s+(view|merge|checks)\b[^\n]*\bsleep\b/, label: "gh pr polling loop" },
];

const BACKGROUNDED = /\b(nohup|setsid|disown)\b|\bsystemd-run\b/;
const LOG_REDIRECTED = /[>&]{1,2}\s*\/tmp\/\S+\.log/;

/** In the abort-risk class AND not already backgrounded → block with recipe. */
export function bashLongRunVerdict(cmd: string, env: Record<string, string | undefined> = {}): BashLongRunVerdict {
	if (env.BASH_LONG_RUN_GUARD === "0") return { background: false };
	const c = cmd.trim();
	if (!c) return { background: false };
	// Canonical safe shape already: backgrounded AND retrieving from a /tmp log.
	if (BACKGROUNDED.test(c) && LOG_REDIRECTED.test(c)) return { background: false };
	if (BACKGROUNDED.test(c)) return { background: false };
	for (const p of RISK_PATTERNS) {
		if (p.re.test(c)) {
			return {
				background: true,
				reason: `"${p.label}" runs silent-and-foreground on the tool channel, which intermittently aborts calls a few seconds in (recurring "Command aborted" class — daemon restarts do not fix it)`,
				recipe: `L=/tmp/blk-$RANDOM$RANDOM.log; setsid nohup bash -c '${c.replace(/'/g, "'\\''")} >$L 2>&1 </dev/null; echo EXIT:$? >>$L' >/dev/null 2>&1 & sleep 1; tail -5 $L`,
			};
		}
	}
	return { background: false };
}
