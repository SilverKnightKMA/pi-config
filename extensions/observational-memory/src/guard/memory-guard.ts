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

const MUTATION = /\b(rm|mv|tee|truncate|shred|dd|mkdir|rmdir|chmod|chown|rsync|install)\b|>>|>[ \t>]*\S*\.memory|sed\s+(-[a-zA-Z]*)*i|perl\s+(-[a-zA-Z]*)*i\b|python3?\s+-c|node\s+-e|\bxargs\b/;
/** cp mutates only when a `.memory` path is the FINAL argument (the destination). */
const CP_INTO_MEMORY = /\bcp\b[^|;&]*\s\S*\.memory(\/[^\s|;&]*)?\s*$/;

/** True when `t` is a clean path token referencing the memory tree. */
function isMemoryPathToken(t: string): boolean {
	return (
		t === ".memory" ||
		t === ".memory/" ||
		t.startsWith(".memory/") ||
		t.endsWith("/.memory") ||
		t.includes("/.memory/")
	);
}

/**
 * v1.4.25: "mention" = a clean PATH TOKEN referencing `.memory`, not the
 * substring anywhere. The old test false-positived on chained commands where
 * a legitimate mutation shape elsewhere in the chain (sed -i pkg.json)
 * combined with the string `.memory` inside a commit message / grep pattern —
 * two unrelated segments read as one "mutate .memory" verdict. Prose spans
 * are quoted multi-word strings; quoted spans only count when their FIRST
 * token is a memory path (so `rm -rf ".memory/foo bar"` still matches), and
 * nested quotes (python -c "open('.memory/a','w')") are scanned too.
 */
export function mentionsMemoryPath(command: string): boolean {
	const spans: { text: string; quoted: boolean }[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	for (const ch of command) {
		if (quote) {
			if (ch === quote) {
				spans.push({ text: buf, quoted: true });
				buf = "";
				quote = null;
			} else buf += ch;
		} else if (ch === '"' || ch === "'") {
			if (buf) spans.push({ text: buf, quoted: false });
			buf = "";
			quote = ch;
		} else buf += ch;
	}
	if (buf) spans.push({ text: buf, quoted: false }); // unterminated quote — treat as unquoted (safe)

	for (const s of spans) {
		if (!s.quoted) {
			for (const tok of s.text.split(/\s+/)) if (isMemoryPathToken(tok)) return true;
		} else {
			const head = s.text.split(/\s+/)[0] ?? "";
			if (isMemoryPathToken(head)) return true;
			// nested single/double quotes inside the span (python/node -c strings)
			const inner = s.text.match(/'[^']*'|"[^"]*"/g) ?? [];
			for (const m of inner) {
				const t = m.slice(1, -1).split(/\s+/)[0] ?? "";
			if (isMemoryPathToken(t)) return true;
		}
		}
	}
	return false;
}

/**
 * Classify a bash command that touches `.memory` via a path token:
 * "mutate" (block), "read" (allow). Commands with no memory path token are "none".
 */
export function classifyBashMemoryTouch(command: string): "none" | "read" | "mutate" {
	if (!mentionsMemoryPath(command)) return "none";
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
