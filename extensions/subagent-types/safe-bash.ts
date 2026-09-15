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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { checkBash, defaultWriteAllowlist, type WriteAllowlist } from "./safe-bash-rules.ts";

export interface SafeBashOptions {
	/** Lazily resolved role of THIS session (undefined until the Paseo label lands). */
	getRole?: () => string | undefined;
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

export default function safeBash(pi: ExtensionAPI, opts: SafeBashOptions = {}) {
	const bashTool = createBashTool(process.cwd());
	const cwd = process.cwd();
	const configured = roleWriteAllowlists(cwd);

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
				throw new Error(
					[
						`⛔ safe_bash denied — ${denial.what}`,
						`WHY: ${denial.why}`,
						`WHERE: ${denial.where}`,
						`NEXT: ${denial.next}`,
					].join("\n"),
				);
			}
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
