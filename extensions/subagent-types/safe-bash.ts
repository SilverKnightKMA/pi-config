/**
 * Safe bash extension for worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * v1.4.79 (#34/#43): the 16 flat regexes are replaced by AST segmentation
 * (safe-bash-rules.ts, unbash parser) — heredoc payloads are data, nested
 * substitutions are walked, parse fails closed, protected paths (agent
 * self-escalation vectors) are mandatory-denied, and role write allowlists
 * come from settings.json `subagentTypes.roleWriteAllowlist`. Every denial
 * renders the #43 envelope: WHAT / WHY / WHERE / NEXT.
 *
 * v1.4.93 (#108): (a) shadow telemetry (pi-verdict) — every verdict, allow
 * OR deny, lands in ~/.pi/agent/safe-bash-shadow.jsonl so blocked-command
 * trends are reviewable offline (SAFE_BASH_SHADOW=0 disables); (b) git-aware
 * destructive warning (@spences10/pi-confirm-destructive) — a deny in a
 * DESTRUCTIVE_RULES class inside a dirty git worktree appends a porcelain
 * warning to the envelope (amplifies, never blocks); (c) private-data
 * mandatory-deny list lives in safe-bash-rules (pi-approval-guardian).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";
import { checkBash, defaultWriteAllowlist, DESTRUCTIVE_RULES, type BashDenial, type WriteAllowlist } from "./safe-bash-rules.ts";

export interface SafeBashOptions {
	/** Lazily resolved role of THIS session (undefined until the Paseo label lands). */
	getRole?: () => string | undefined;
	/** #108 shadow log target (tests inject a temp path). */
	shadowLogPath?: string;
	/** #108 porcelain probe for the git-aware warning (tests inject a stub). */
	gitPorcelain?: () => string | null;
}

function readSettingsJson(file: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Workspace overrides user-wide (same merge as mainBlockedTools). */
function roleWriteAllowlists(cwd: string): Record<string, string[]> {
	const ws = readSettingsJson(join(cwd, ".pi", "settings.json"));
	const user = readSettingsJson(join(os.homedir(), ".pi", "agent", "settings.json"));
	const pick = (src: Record<string, unknown>): Record<string, string[]> => {
		const cfg = (src as { subagentTypes?: { roleWriteAllowlist?: unknown } }).subagentTypes?.roleWriteAllowlist;
		if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return {};
		const out: Record<string, string[]> = {};
		for (const [role, prefixes] of Object.entries(cfg as Record<string, unknown>)) {
			if (Array.isArray(prefixes) && prefixes.every((p) => typeof p === "string")) out[role] = prefixes as string[];
		}
		return out;
	};
	return { ...pick(user), ...pick(ws) };
}

/** #108 shadow telemetry line (pi-verdict): review "what got blocked" trends.
 *  Best-effort — a telemetry failure must never change the verdict. */
export interface ShadowLine {
	ts: string;
	role?: string;
	verdict: "allow" | "deny";
	rule?: string;
	what?: string;
	command: string;
	cwd: string;
}

export function writeShadowLine(line: ShadowLine, path: string): void {
	try {
		appendFileSync(path, JSON.stringify(line) + "\n");
	} catch {
		/* best effort */
	}
}

/** #108 git-aware warning (@spences10): a destructive-class deny inside a DIRTY
 *  worktree gets one extra envelope line. Pure — porcelain output injected. */
export function appendGitAwareWarning(envelope: string, denial: BashDenial, porcelain: string | null): string {
	if (!DESTRUCTIVE_RULES.has(denial.rule)) return envelope;
	if (porcelain === null) return envelope; // no repo / probe failed → no warning
	const dirty = porcelain.split("\n").filter((l) => l.trim().length > 0);
	if (dirty.length === 0) return envelope;
	return `${envelope}\nGIT-AWARE: worktree is dirty (${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} — e.g. ${dirty[0].trim().slice(0, 80)}); this command would have destroyed work git cannot recover. Commit or stash first.`;
}

function defaultGitPorcelain(cwd: string): () => string | null {
	return () => {
		try {
			return execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) as string;
		} catch {
			return null; // not a repo, or git slow/missing — no warning, never an error
		}
	};
}

export default function safeBash(pi: ExtensionAPI, opts: SafeBashOptions = {}) {
	const bashTool = createBashTool(process.cwd());
	const cwd = process.cwd();
	const configured = roleWriteAllowlists(cwd);
	const shadowPath = opts.shadowLogPath ?? join(os.homedir(), ".pi", "agent", "safe-bash-shadow.jsonl");
	const shadowOn = process.env.SAFE_BASH_SHADOW !== "0";
	const gitPorcelain = opts.gitPorcelain ?? defaultGitPorcelain(cwd);

	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. AST-segmented guard: blocks destructive commands (rm -rf /, sudo, mkfs, curl|sh…), writes to protected agent/shell config, and role-out-of-scope writes. Denials include WHY + a legitimate NEXT step.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const role = opts.getRole?.();
			const allowlist: WriteAllowlist = role !== undefined && role in configured
				? configured[role]
				: defaultWriteAllowlist(role, cwd);
			const denial = checkBash(params.command, { role, writeAllowlist: allowlist });
			if (denial) {
				if (shadowOn) {
					writeShadowLine(
						{ ts: new Date().toISOString(), role, verdict: "deny", rule: denial.rule, what: denial.what, command: params.command.slice(0, 200), cwd },
						shadowPath,
					);
				}
				const base = [
					`⛔ safe_bash denied — ${denial.what}`,
					`WHY: ${denial.why}`,
					`WHERE: ${denial.where}`,
					`NEXT: ${denial.next}`,
				].join("\n");
				// #108 git-aware: dirty worktree + destructive class → amplified envelope.
				throw new Error(appendGitAwareWarning(base, denial, gitPorcelain()));
			}
			if (shadowOn) {
				writeShadowLine({ ts: new Date().toISOString(), role, verdict: "allow", command: params.command.slice(0, 200), cwd }, shadowPath);
			}
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
