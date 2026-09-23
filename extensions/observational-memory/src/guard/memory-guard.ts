/**
 * memory-guard — the machine-written memory surfaces, protected.
 *
 * #250 (M3) DENY-LIST — what this guard protects (all MACHINE-WRITTEN, single
 * sanctioned writer each; the MODEL never writes them):
 *   - `~/.pi/agent/facts.md`    — durable facts tier (regex trigger P2 + memory-curator)
 *   - `~/.pi/agent/lessons.md`  — global lessons tier (auto-injected, curated)
 *   - `~/.pi/agent/facts-runs/` — curator run receipts (headless curator sessions)
 *   - `<cwd>/.memory/`          — observational-memory tree (observer/consolidator
 *                                 single-writer; runtime OM state lives here too)
 *
 * NOT guarded (MODEL-OWNED by design — never add them here):
 *   - `~/.pi/agent/task-status/`  — task ext projection + decisions artifact
 *   - `~/.pi/agent/task-control/` — user→engine control files
 *
 * Three layers (2026-09-01 design, user-approved):
 *   1. hard:   pi.on("tool_call") blocks write/edit into the trees above and
 *              bash/safe_bash commands that mutate them (#250: per-SEGMENT
 *              classification — an unrelated mutation shape in another
 *              segment no longer blocks a pure read);
 *   2. soft:   pi.on("context") appends a one-paragraph policy line to the
 *              system prompt every LLM call (~40 tok, non-destructive);
 *   3. escape: `/om off` disables both (admin/repair mode), and OM worker
 *              subprocesses (env OM_WORKER / FACTS_WORKER) are always exempt
 *              — they are the sanctioned writers.
 *
 * bash stays a documented, deliberate escape hatch (obfuscated paths can
 * bypass the classifier); blocking the obvious mutations stops accidents and
 * sloppy "helpful" edits, which is the actual failure mode. Uncertain
 * tokenization (unterminated quotes) fails CLOSED — whole-command rules.
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

// --- facts tier guard (P1d, #177, plan 2026-09-21) ---------------------------
// The durable tiers ~/.pi/agent/facts.md + lessons.md and the curator's
// receipts dir ~/.pi/agent/facts-runs/ are MACHINE-WRITTEN (regex trigger P2,
// memory-curator P3, OM consolidator). The MODEL never writes them — same
// doctrine as .memory/ above. Reads are always fine (facts_recall / cat).

/** Expand a leading `~` the way a shell would before resolving. */
function expandTilde(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return home + p.slice(1);
	return p;
}

/** True when `path` resolves to the facts tier under `home`. */
export function isFactsTierPath(
	path: string | undefined,
	cwd: string,
	home: string = process.env.HOME ?? "",
): boolean {
	const abs = resolveAgainst(path === undefined ? undefined : expandTilde(path, home), cwd);
	if (!abs) return false;
	const facts = resolve(home, ".pi/agent/facts.md");
	const lessons = resolve(home, ".pi/agent/lessons.md");
	const runs = resolve(home, ".pi/agent/facts-runs");
	return abs === facts || abs === lessons || abs === runs || abs.startsWith(runs + sep);
}

/** True when `t` is a clean path token referencing the facts tier under
 *  ~/.pi/agent — `~`-relative, `$HOME`-expanded, or absolute. A bare
 *  `facts.md` in the workspace does NOT count (a different file). */
function isFactsTierToken(t: string): boolean {
	if (t.startsWith("~/")) t = t.slice(1);
	return /(^|\/)\.pi\/agent\/(facts\.md|lessons\.md|facts-runs)(\/|$)/.test(t) || t.includes("$HOME/.pi/agent/");
}

/** Same mention-scan as mentionsMemoryPath but for facts-tier tokens. */
export function mentionsFactsTierPath(command: string, home: string = process.env.HOME ?? ""): boolean {
	const expanded = command.split("$HOME").join(home);
	// reuse the span tokenizer: quoted spans count only when their head token matches
	const spans: { text: string; quoted: boolean }[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	for (const ch of expanded) {
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
	if (buf) spans.push({ text: buf, quoted: false });
	for (const s of spans) {
		if (!s.quoted) {
			for (const tok of s.text.split(/\s+/)) if (isFactsTierToken(tok)) return true;
		} else {
			const head = s.text.split(/\s+/)[0] ?? "";
			if (isFactsTierToken(head)) return true;
			const inner = s.text.match(/'[^']*'|"[^"]*"/g) ?? [];
			for (const m of inner) {
			const t = m.slice(1, -1).split(/\s+/)[0] ?? "";
			if (isFactsTierToken(t)) return true;
		}
		}
	}
	return false;
}

/** Classify a bash command against the facts tier: "mutate" (block) /
 *  "read" (allow) / "none" (not our tree).
 *
 *  #250 (M1, v1.4.140): classification is PER-SEGMENT, not per-command. The
 *  old whole-command rule false-positived live (twice on 2026-09-22): a
 *  compound like `…; python3 -c "…unrelated json…"; ls ~/.pi/agent/facts-runs/`
 *  was blocked because MUTATION matched the python segment while the tier
 *  mention lived in a DIFFERENT segment. Now a command blocks only when at
 *  least one segment BOTH mentions the tier AND mutates by itself. */
const CP_INTO_FACTS_TIER = /\bcp\b[^|;&]*\s\S*\.pi\/agent\/(facts\.md|lessons\.md|facts-runs)(\/[^\s|;&]*)?\s*$/;
/** `>` redirect whose DESTINATION token is the facts tier (`echo x > ~/.pi/agent/facts.md`);
 *  `> /dev/null` while reading the tier does NOT match (destination is /dev/null). */
const REDIRECT_INTO_FACTS_TIER = />[ \t>]*~?\/?[^\s|;&;]*\.pi\/agent\/(facts\.md|lessons\.md|facts-runs)(\/[^\s|;&]*)?(\s|$)/;

/** #250 (M1): split a command into `;` `&&` `||` `|` segments, respecting
 *  quotes. Returns null when tokenization is uncertain (unterminated quote)
 *  — callers then fail CLOSED: whole-command classification, the pre-M1 rule. */
export function splitSegments(command: string): string[] | null {
	const segs: string[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote) {
			buf += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			buf += ch;
			quote = ch;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&") {
			let j = i;
			while (j < command.length && (command[j] === ";" || command[j] === "|" || command[j] === "&")) j++;
			segs.push(buf);
			buf = "";
			i = j - 1;
			continue;
		}
		buf += ch;
	}
	if (quote) return null; // unterminated quote — uncertain → fail closed upstream
	if (buf.trim()) segs.push(buf);
	return segs;
}

function factsSegMutates(seg: string): boolean {
	return MUTATION.test(seg) || CP_INTO_FACTS_TIER.test(seg) || REDIRECT_INTO_FACTS_TIER.test(seg);
}

export function classifyBashFactsTierTouch(command: string, home: string = process.env.HOME ?? ""): "none" | "read" | "mutate" {
	if (!mentionsFactsTierPath(command, home)) return "none";
	const segs = splitSegments(command);
	if (segs === null) {
		// uncertain tokenization — fail CLOSED (the pre-M1 whole-command rule)
		return factsSegMutates(command) ? "mutate" : "read";
	}
	return segs.some((seg) => mentionsFactsTierPath(seg, home) && factsSegMutates(seg)) ? "mutate" : "read";
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
 * #250 (M1, v1.4.140): PER-SEGMENT — same fix as the facts tier above; a
 *  mutation shape in one segment no longer blocks a pure read in another.
 */
export function classifyBashMemoryTouch(command: string): "none" | "read" | "mutate" {
	if (!mentionsMemoryPath(command)) return "none";
	const segs = splitSegments(command);
	const whole = (seg: string) => CP_INTO_MEMORY.test(seg) || MUTATION.test(seg);
	if (segs === null) {
		// uncertain tokenization — fail CLOSED (the pre-M1 whole-command rule)
		return whole(command) ? "mutate" : "read";
	}
	return segs.some((seg) => mentionsMemoryPath(seg) && whole(seg)) ? "mutate" : "read";
}

const POLICY =
	"[memory-policy] The `.memory/` directory is owned by the observational-memory pipeline " +
	"(observer/consolidator decide its content). Never create, edit, move, or delete anything " +
	"under `.memory/` with write/edit/bash — reading (cat/ls/grep/read) is always fine. " +
	"The durable memory tiers `~/.pi/agent/facts.md` and `~/.pi/agent/lessons.md` (and `facts-runs/`) " +
	"are machine-written too — read them freely (facts_recall), never edit them. " +
	"For emergency repairs ask the user to run `/om off` first.";

const FACTS_ENVELOPE =
	"memory-guard: ~/.pi/agent/facts.md, lessons.md and facts-runs/ are machine-written memory " +
	"tiers (single writer: regex trigger / memory-curator / OM consolidator). " +
	"WHAT: this write is blocked. WHY: model edits would race the sanctioned writers and bypass " +
	"the tombstone lifecycle. NEXT: read is fine (facts_recall / cat); to record a durable fact " +
	"tell the user — they own the store; for repairs ask the user to run `/om off` first.";

/** Wire layers 1+2. No-op when OM is disabled (`/om off` = admin mode). */
export function registerMemoryGuard(pi: ExtensionAPI, isEnabled: () => boolean): void {
	pi.on("tool_call", (event: any, ctx: any) => {
		if (!isEnabled()) return;
		if (process.env.OM_WORKER || process.env.FACTS_WORKER) return; // sanctioned writer subprocesses
		const tool = typeof event?.toolName === "string" ? event.toolName : "";
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		const home = process.env.HOME ?? "";
		if (tool === "write" || tool === "edit") {
			if (isMemoryPath(event?.input?.path, cwd)) {
				return {
					block: true,
					reason:
						"memory-guard: `.memory/` is managed by observational-memory (write/edit blocked). " +
						"Read it freely; for repairs ask the user to run `/om off` first.",
				};
			}
			if (isFactsTierPath(event?.input?.path, cwd, home)) {
				return { block: true, reason: FACTS_ENVELOPE };
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
			if (classifyBashFactsTierTouch(cmd, home) === "mutate") {
				return { block: true, reason: FACTS_ENVELOPE };
			}
			return;
		}
	});

	pi.on("context", async (event: any) => {
		if (!isEnabled()) return undefined;
		if (process.env.OM_WORKER || process.env.FACTS_WORKER) return undefined;
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
