import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * bash-long-run-guard — v1.4.71 (2026-09-15).
 *
 * Guards the recurring "Command aborted" class: silent foreground bash calls
 * (test suites, installs, sleeps, polling loops) intermittently die on the
 * Paseo↔pi tool channel a few seconds in, even though the underlying work
 * completes. The fix (documented in the learn-session manual after the user
 * hit it repeatedly) is to route them through the background pattern UP FRONT.
 * This extension enforces exactly that — deterministic, model-free — instead
 * of relying on the model remembering the rule.
 *
 * Denials follow the #43 envelope (WHAT / WHY / NEXT with a ready-to-run
 * recipe). Escape: BASH_LONG_RUN_GUARD=0 restores raw behavior.
 */
import { bashLongRunVerdict } from "./src/match.ts";

export default function activate(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash" && event.toolName !== "safe_bash") return;
		const ev = event as unknown as { toolName?: string; args?: unknown };
		const args = (ev.args ?? {}) as { command?: unknown };
		if (typeof args.command !== "string") return;
		const v = bashLongRunVerdict(args.command, process.env as Record<string, string | undefined>);
		if (!v.background) return;
		return {
			block: true,
			reason:
				`WHAT: this bash call is blocked by bash-long-run-guard. ${v.reason}. ` +
				`WHY: the aborted call leaves a broken turn that the user has to nudge ("tiếp tục") — the user's top recurring complaint. ` +
				`NEXT: run the background pattern instead and read the log:\n${v.recipe}\n` +
				`(escape hatch: BASH_LONG_RUN_GUARD=0)`,
		};
	});
}
