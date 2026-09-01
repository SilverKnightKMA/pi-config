/**
 * memory-guard — keep `.memory/` owned by the observational-memory pipeline.
 *
 * Three layers (2026-09-01 design, user-approved):
 *   1. hard:   pi.on("tool_call") blocks write/edit into `.memory/` and
 *              bash/safe_bash commands that mutate it;
 *   2. soft:   pi.on("context") appends a one-paragraph policy line to the
 *              system prompt every LLM call (~40 tok, non-destructive);
 *   3. escape: `/om off` disables both (admin/repair mode), and OM worker
 *              subprocesses (env OM_WORKER) are always exempt — they are the
 *              sanctioned writers.
 *
 * bash stays a documented, deliberate escape hatch (obfuscated paths can
 * bypass the classifier); blocking the obvious mutations stops accidents and
 * sloppy "helpful" edits, which is the actual failure mode.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, sep } from "node:path";

/** Resolve a maybe-relative path the way the tools do. */
function resolveAgainst(path: string | undefined, cwd: string): string | undefined {
	if (!path) return undefined;
	try {
		return resolve(cwd, path);
	} catch {
		return undefined;
	}
}

/** True when `path` is inside `<cwd>/.memory/` (the memory tree itself included). */
export function isMemoryPath(path: string | undefined, cwd: string): boolean {
	const abs = resolveAgainst(path, cwd);
	if (!abs) return false;
	const root = resolve(cwd, ".memory");
	return abs === root || abs.startsWith(root + sep);
}

const MEMORY_MENTION = /\.memory\b/;
const MUTATION = /\b(rm|mv|tee|truncate|shred|dd|mkdir|rmdir|chmod|chown|rsync|install)\b|>>|>[ \t>]*\S*\.memory|sed\s+(-[a-zA-Z]*)*i|perl\s+(-[a-zA-Z]*)*i\b|python3?\s+-c|node\s+-e|\bxargs\b/;
/** cp mutates only when a `.memory` path is the FINAL argument (the destination). */
const CP_INTO_MEMORY = /\bcp\b[^|;&]*\s\S*\.memory(\/[^\s|;&]*)?\s*$/;

/**
 * Classify a bash command that mentions `.memory`:
 * "mutate" (block), "read" (allow). Commands not mentioning `.memory` are "none".
 */
export function classifyBashMemoryTouch(command: string): "none" | "read" | "mutate" {
	if (!MEMORY_MENTION.test(command)) return "none";
	if (CP_INTO_MEMORY.test(command)) return "mutate";
	if (MUTATION.test(command)) return "mutate";
	return "read";
}

const POLICY =
	"[memory-policy] The `.memory/` directory is owned by the observational-memory pipeline " +
	"(observer/consolidator decide its content). Never create, edit, move, or delete anything " +
	"under `.memory/` with write/edit/bash — reading (cat/ls/grep/read) is always fine. " +
	"For emergency repairs ask the user to run `/om off` first.";

/** Wire layers 1+2. No-op when OM is disabled (`/om off` = admin mode). */
export function registerMemoryGuard(pi: ExtensionAPI, isEnabled: () => boolean): void {
	pi.on("tool_call", (event: any, ctx: any) => {
		if (!isEnabled()) return;
		if (process.env.OM_WORKER) return; // sanctioned writer subprocesses
		const tool = typeof event?.toolName === "string" ? event.toolName : "";
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		if (tool === "write" || tool === "edit") {
			if (isMemoryPath(event?.input?.path, cwd)) {
				return {
					block: true,
					reason:
						"memory-guard: `.memory/` is managed by observational-memory (write/edit blocked). " +
						"Read it freely; for repairs ask the user to run `/om off` first.",
				};
			}
			return;
		}
		if (tool === "bash" || tool === "safe_bash") {
			const cmd = typeof event?.input?.command === "string" ? event.input.command : "";
			if (classifyBashMemoryTouch(cmd) === "mutate") {
				return {
					block: true,
					reason:
						"memory-guard: this command would mutate `.memory/`, which is managed by " +
						"observational-memory. Reads are fine; for repairs ask the user to run `/om off` first.",
				};
			}
			return;
		}
	});

	pi.on("context", async (event: any) => {
		if (!isEnabled()) return undefined;
		if (process.env.OM_WORKER) return undefined;
		const messages = event?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return undefined;
		if (messages[0]?.role === "system") {
			const head = messages[0];
			const content = typeof head.content === "string" ? head.content + "\n\n" + POLICY : POLICY;
			return { messages: [{ ...head, content }, ...messages.slice(1)] };
		}
		return { messages: [{ role: "system", content: POLICY }, ...messages] };
	});
}
