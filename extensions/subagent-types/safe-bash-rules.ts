/**
 * safe-bash-rules — AST-segmented deny rules for the safe_bash wrapper.
 *
 * #34/#43 (2026-09-16): replaces the 16 flat regexes with unbash AST
 * segmentation — the mechanism ported from opencode-bash-guard (MIT; see
 * docs/upstream-registry.md). Commands are judged per-segment:
 *   - heredoc payloads are DATA, never scanned as commands (kills the
 *     land-bash-safety false-positive class: `grep "rm -rf" notes.md`,
 *     documentation heredocs);
 *   - nested $(...), `...` and <(...) are walked recursively with a depth
 *     tag, so `echo $(rm -rf /)` is denied at the rm segment;
 *   - env-assignment prefixes (`FOO=1 rm -rf /`) cannot disguise the command
 *     name — the parser separates prefix from name (Warp's env-strip lesson);
 *   - write redirects are resolved to paths and checked against a
 *     mandatory-deny list (agent self-escalation vectors: .bashrc, .gitconfig,
 *     .git/hooks/*, .mcp.json, pi settings.json) and an optional per-role
 *     write allowlist;
 *   - parse errors fail CLOSED (opencode-bash-guard doctrine).
 *
 * Every denial follows the #43 envelope: WHAT / WHY / WHERE / NEXT — the NEXT
 * line always points at a legitimate path, never at evasion.
 */
import { parse } from "unbash";

export interface BashDenial {
	/** Stable rule id (tests + telemetry). */
	rule: string;
	/** ⛔ WHAT — one-line denial. */
	what: string;
	/** WHY — plain-language reason, never a raw regex. */
	why: string;
	/** WHERE — which segment and nesting depth. */
	where: string;
	/** NEXT — the legitimate way to get it done. */
	next: string;
}

/** Role write policy: null = unrestricted, string[] = allowed dir prefixes. */
export type WriteAllowlist = string[] | null;

export interface CheckBashOptions {
	/** Resolved subagent role (from the Paseo agent label); undefined = unknown. */
	role?: string;
	/** Role write allowlist (prefixes, `~` allowed); null/undefined = unrestricted writes. */
	writeAllowlist?: WriteAllowlist;
	/** Home dir override for tests; defaults to os.homedir(). */
	home?: string;
	/** cwd override for tests; defaults to process.cwd(). */
	cwd?: string;
}

// --- unbash AST node shapes (structural subset — no full type import needed) ---
interface UWord {
	text: string;
	value: string;
	pos: number;
	end: number;
	parts?: UWordPart[];
}
interface UWordPart {
	type: string;
	script?: UScript;
	value?: string;
	parts?: UWordPart[];
	operand?: UWord;
	inner?: string;
}
interface URedirect {
	pos: number;
	end: number;
	operator: string;
	target?: UWord;
}
interface UCommand {
	type: "Command";
	pos: number;
	end: number;
	name?: UWord;
	prefix?: { value?: UWord }[];
	suffix?: UWord[];
	redirects?: URedirect[];
}
interface UScript {
	type: "Script";
	commands?: { type: "Statement"; command: UNode; redirects?: URedirect[] }[];
}

type UNode = {
	type: string;
	pos: number;
	end: number;
	// Pipeline / AndOr
	commands?: UNode[];
	// containers with body: CompoundList
	body?: UScript & { commands?: unknown[] } | UNode;
	clause?: unknown;
	then?: unknown;
	else?: unknown;
	// If / While / Select / For share clause/body shapes; Case
	items?: { pattern?: UWord[]; body?: unknown }[];
	word?: UWord;
	// Function / Coproc
	redirects?: URedirect[];
};

const WRITE_REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
/** Heredoc / here-string operators: payload is DATA — never walked as commands. */
const DATA_REDIRECT_OPS = new Set(["<<", "<<-", "<<<"]);

const ROOTY = /^([/~]|\$HOME(?:\/|$))/;
const DEV_BLOCK_RE = /^\/dev\/((s|h)d[a-z]|nvme\d*n\d+|vd[a-z]|mmcblk\d+)/;
const FORK_BOMB_RE = /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/;
const GIT_HOOKS_RE = /(^|\/)\.git\/hooks\//;
const PROTECTED_BASENAMES = new Set([".bashrc", ".bash_profile", ".profile", ".gitconfig", ".mcp.json"]);

const PIPE_SOURCES = new Set(["curl", "wget", "base64"]);
const PIPE_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash"]);

function homeDirOf(opts: CheckBashOptions): string {
	return opts.home ?? process.env.HOME ?? "/home/user";
}

function normalizePath(p: string, home: string): string {
	let s = p.trim();
	if (s.startsWith("~")) s = home + s.slice(1);
	else if (s.startsWith("$HOME")) s = home + s.slice(5);
	return s;
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? p : p.slice(i + 1);
}

function isProtectedWritePath(p: string, home: string): boolean {
	const n = normalizePath(p, home);
	if (PROTECTED_BASENAMES.has(basename(n))) return true;
	if (GIT_HOOKS_RE.test(n)) return true;
	if (n === `${home}/.pi/agent/settings.json`) return true;
	return false;
}

function underAnyPrefix(path: string, prefixes: string[], home: string): boolean {
	const n = normalizePath(path, home);
	return prefixes.some((raw) => {
		const p = normalizePath(raw, home).replace(/\/+$/, "");
		return n === p || n.startsWith(p + "/");
	});
}

/** Split arg words into (flags-string, paths) for rm/chmod-style rules. */
function splitFlags(args: string[]): { flags: string; rest: string[] } {
	const rest: string[] = [];
	let flags = "";
	for (const a of args) {
		if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) flags += a.slice(1);
		else if (a.startsWith("--")) flags += a.slice(2);
		else rest.push(a);
	}
	return { flags, rest };
}

interface WalkCtx {
	source: string;
	home: string;
	role?: string;
	writeAllowlist: WriteAllowlist;
	depth: number;
	segIndex: number;
}

function seg(ctx: WalkCtx, pos: number, end: number): string {
	return ctx.source.slice(pos, Math.min(end, ctx.source.length)).trim().slice(0, 120) || "(empty segment)";
}

function whereOf(ctx: WalkCtx, pos: number, end: number): string {
	const nest = ctx.depth > 0 ? ` inside $()/backtick nesting depth ${ctx.depth}` : "";
	return `segment ${ctx.segIndex} \`${seg(ctx, pos, end)}\`${nest}`;
}

function deny(
	rule: string,
	what: string,
	why: string,
	next: string,
	ctx: WalkCtx,
	pos: number,
	end: number,
): BashDenial {
	return { rule, what, why, next, where: whereOf(ctx, pos, end) };
}

/** Mandatory-deny + role-allowlist check for a write target (redirect or tee arg). */
function checkWriteTarget(target: string, ctx: WalkCtx, pos: number, end: number, how: string): BashDenial | null {
	if (DEV_BLOCK_RE.test(normalizePath(target, ctx.home))) {
		return deny(
			"write-block-device",
			`write to a block device (${target})`,
			"writing directly to a raw disk device destroys filesystems beyond recovery",
			"if you truly need to image a disk, ask the user to run it themselves",
			ctx, pos, end,
		);
	}
	if (isProtectedWritePath(target, ctx.home)) {
		return deny(
			"write-protected-path",
			`write to ${target} (protected agent/shell config)`,
			".bashrc/.gitconfig/.git/hooks/.mcp.json/pi settings.json are self-escalation vectors — editing them could silently change what the agent or shells are allowed to do",
			"ask the user to edit this file themselves (message_main / ask the user); if the change is legitimate they will approve it",
			ctx, pos, end,
		);
	}
	if (ctx.writeAllowlist !== null && !underAnyPrefix(target, ctx.writeAllowlist, ctx.home)) {
		return deny(
			"role-write-allowlist",
			`write to ${target} is outside role ${ctx.role ?? "(unknown)"}'s write allowlist`,
			how === "redirect"
				? "roles have a restricted write surface (redirect targets must stay inside allowed dirs)"
				: "roles have a restricted write surface (tee targets must stay inside allowed dirs)",
			ctx.role
				? `write inside ${ctx.writeAllowlist.join(" or ")} , or message_main asking the parent to widen the allowlist / do the write for you`
				: "this session has no resolved role — ask the parent to spawn with a proper role, or write under /tmp",
			ctx, pos, end,
		);
	}
	return null;
}

/** Per-command deny rules (name + args). Returns denial or null. */
function checkCommand(node: UCommand, ctx: WalkCtx): BashDenial | null {
	const name = node.name?.value ?? "";
	const args = (node.suffix ?? []).map((w) => w.value);
	ctx.segIndex += 1;
	const pos = node.pos;
	const end = node.end;

	if (name === "sudo") {
		return deny(
			"sudo",
			"sudo is not available to subagents",
			"root escalation bypasses every safety layer of this workspace",
			"ask the user to run the privileged command themselves (message_main / ask the user)",
			ctx, pos, end,
		);
	}
	if (name.startsWith("mkfs")) {
		return deny("mkfs", `filesystem creation (${name})`, "mkfs irreversibly formats a device",
			"formatting storage is a user-level decision — ask the user", ctx, pos, end);
	}
	if (name === "shutdown" || name === "reboot" || name === "halt" || name === "poweroff") {
		return deny("power", `${name} affects the whole machine`, "power commands take down every workspace on this host",
			"ask the user; never stop the machine from a subagent", ctx, pos, end);
	}
	if (name === "killall") {
		return deny("killall", "killall kills by name across the system", "name-matched kills can take down unrelated processes",
			"target a specific PID with kill <pid>, or ask the user", ctx, pos, end);
	}
	if (name === "init" && args[0] === "0") {
		return deny("init-0", "init 0 halts the machine", "direct init-level poweroff affects the whole host",
			"ask the user", ctx, pos, end);
	}
	if (name === "kill") {
		const { rest } = splitFlags(args);
		if ((args.some((a) => /^-9$|^-\w*9\w*$/.test(a)) || args.includes("-KILL") || args.includes("-s") ) && (rest.includes("1") || rest.includes("$PPID"))) {
			return deny("kill-1", "kill -9 targeting PID 1", "killing PID 1 takes down the container/host init",
				"stop the specific process you own instead", ctx, pos, end);
		}
	}
	if (name === "dd" && args.some((a) => a.startsWith("if="))) {
		return deny("dd", `dd with an input file (${args.find((a) => a.startsWith("if=")) ?? ""})`,
			"dd copies raw blocks — a wrong of= target can wipe a disk",
			"use file-level copy tools (cp/rsync) for regular files; disk imaging is a user action", ctx, pos, end);
	}
	if (name === "rm") {
		const { flags, rest } = splitFlags(args);
		const destructive = /[fr]/.test(flags);
		const rooty = rest.some((p) => ROOTY.test(p) || p === "/" || p === "~" || p === "$HOME");
		if (destructive && rooty) {
			return deny("rm-root", `recursive/forced rm on a root-anchored path (${rest.filter((p) => ROOTY.test(p)).join(" ")})`,
				"rm -f/-r on /, ~ or absolute paths is how whole trees get erased in one typo",
				"cd into the workspace and rm relative paths (e.g. rm -rf build/), or list the exact files for the user to approve",
				ctx, pos, end);
		}
	}
	if (name === "chmod") {
		if (args.includes("777") && args.some((a, i) => i > 0 && a.startsWith("/"))) {
			return deny("chmod-777-root", "chmod 777 on an absolute path", "world-writable system paths are a privilege-escalation hole",
				"narrow the permission change to a workspace-relative path", ctx, pos, end);
		}
	}
	if (name === "chown" && args.some((a) => /^root([:.]|$)/.test(a))) {
		return deny("chown-root", "chown to root", "root ownership changes on agent-created files are an escalation vector",
			"keep files owned by the workspace user", ctx, pos, end);
	}
	if (name === "tee") {
		const targets = args.filter((a) => !a.startsWith("-"));
		for (const t of targets) {
			const d = checkWriteTarget(t, ctx, pos, end, "tee");
			if (d) return d;
		}
	}
	return null;
}

/** Write-op redirect checks (mandatory-deny list + role allowlist + block devices). */
function checkRedirect(r: URedirect, ctx: WalkCtx): BashDenial | null {
	if (DATA_REDIRECT_OPS.has(r.operator)) return null; // heredoc/here-string payload = data
	if (!WRITE_REDIRECT_OPS.has(r.operator)) return null;
	const target = r.target?.value;
	if (!target) return null; // >&fd dup etc. — not a file write
	return checkWriteTarget(target, ctx, r.pos, r.end, "redirect");
}

function walkWord(w: UWord | undefined, ctx: WalkCtx, out: BashDenial[]): void {
	if (!w?.parts) return;
	for (const p of w.parts) walkPart(p, ctx, out);
}

function walkPart(p: UWordPart, ctx: WalkCtx, out: BashDenial[]): void {
	if (p.script) {
		const d = walkScript(p.script, ctx.depth + 1, ctx);
		if (d) out.push(d);
	}
	if (p.parts) for (const c of p.parts) walkPart(c, ctx, out);
	if (p.operand) walkWord(p.operand, ctx, out);
}

function walkNode(node: UNode | undefined, ctx: WalkCtx, out: BashDenial[]): void {
	if (!node) return;
	switch (node.type) {
		case "Command": {
			const c = node as unknown as UCommand;
			const d = checkCommand(c, ctx);
			if (d) out.push(d);
			for (const r of c.redirects ?? []) {
				const dr = checkRedirect(r, ctx);
				if (dr) out.push(dr);
			}
			walkWord(c.name, ctx, out);
			for (const w of c.suffix ?? []) walkWord(w, ctx, out);
			for (const a of c.prefix ?? []) walkWord(a.value, ctx, out);
			return;
		}
		case "Pipeline": {
			const kids = node.commands ?? [];
			for (const k of kids) walkNode(k, ctx, out);
			// pipe-to-shell exfil/execute: curl|sh, wget|bash, base64 -d|sh …
			const names = kids
				.filter((k) => k.type === "Command")
				.map((k) => (k as unknown as UCommand).name?.value ?? "")
				.filter(Boolean);
			const src = names.find((n) => PIPE_SOURCES.has(n));
			const shell = names.find((n) => PIPE_SHELLS.has(n));
			if (src && shell) {
				out.push(deny(
					"pipe-to-shell",
					`${src} piped into ${shell}`,
					"piping a downloader/base64 blob straight into a shell runs unreviewed code with no inspection point",
					`download to a file first (${src} -o /tmp/x), read it, then run it deliberately`,
					ctx, node.pos, node.end,
				));
			}
			return;
		}
		case "AndOr": {
			for (const k of node.commands ?? []) walkNode(k, ctx, out);
			return;
		}
		case "Statement": {
			const st = node as unknown as { command: UNode; redirects?: URedirect[] };
			for (const r of st.redirects ?? []) {
				const dr = checkRedirect(r, ctx);
				if (dr) out.push(dr);
			}
			walkNode(st.command, ctx, out);
			return;
		}
		case "If": {
			const n = node as unknown as { clause: { commands: unknown[] }; then: { commands: unknown[] }; else?: unknown };
			walkCompound(n.clause, ctx, out);
			walkCompound(n.then, ctx, out);
			walkElse(n.else, ctx, out);
			return;
		}
		case "While":
		case "Select": {
			const n = node as unknown as { clause: { commands: unknown[] }; body: { commands: unknown[] } };
			walkCompound(n.clause, ctx, out);
			walkCompound(n.body, ctx, out);
			return;
		}
		case "For":
		case "ArithmeticFor": {
			const n = node as unknown as { body: { commands: unknown[] } };
			walkCompound(n.body, ctx, out);
			return;
		}
		case "Function":
		case "Coproc": {
			const n = node as unknown as { body: UNode; redirects?: URedirect[] };
			for (const r of n.redirects ?? []) {
				const dr = checkRedirect(r, ctx);
				if (dr) out.push(dr);
			}
			walkNode(n.body, ctx, out);
			return;
		}
		case "Subshell":
		case "BraceGroup": {
			const n = node as unknown as { body: { commands: unknown[] } };
			walkCompound(n.body, ctx, out);
			return;
		}
		case "Case": {
			for (const item of node.items ?? []) {
				for (const w of item.pattern ?? []) walkWord(w, ctx, out);
				walkCompound(item.body as { commands: unknown[] } | undefined, ctx, out);
			}
			return;
		}
		default:
			// TestCommand / ArithmeticCommand / CompoundList passed directly — nothing executable at this level.
			return;
	}
}

function walkCompound(list: { commands?: unknown[] } | undefined, ctx: WalkCtx, out: BashDenial[]): void {
	if (!list?.commands) return;
	for (const st of list.commands) {
		const s = st as unknown as { type: string; command?: UNode; redirects?: URedirect[] };
		if (s.type === "Statement") {
			for (const r of s.redirects ?? []) {
				const dr = checkRedirect(r, ctx);
				if (dr) out.push(dr);
			}
			walkNode(s.command, ctx, out);
		} else {
			walkNode(s as UNode, ctx, out);
		}
	}
}

function walkElse(node: unknown, ctx: WalkCtx, out: BashDenial[]): void {
	if (!node || typeof node !== "object") return;
	const n = node as { type?: string; commands?: unknown[] };
	if (n.type === "If") walkNode(n as UNode, ctx, out);
	else walkCompound(n as { commands: unknown[] }, ctx, out);
}

function walkScript(script: UScript, depth: number, ctx: WalkCtx): BashDenial | null {
	const inner: WalkCtx = { ...ctx, depth };
	for (const st of script.commands ?? []) {
		for (const r of st.redirects ?? []) {
			const dr = checkRedirect(r, inner);
			if (dr) return dr;
		}
		const out: BashDenial[] = [];
		walkNode(st.command, inner, out);
		if (out.length > 0) return out[0];
	}
	return null;
}

/**
 * Judge a full bash command string. Returns the first denial (envelope
 * WHAT/WHY/WHERE/NEXT) or null when every segment is safe. Parse errors
 * fail CLOSED.
 */
export function checkBash(command: string, opts: CheckBashOptions = {}): BashDenial | null {
	// Literal fork-bomb signature (kept raw: it is an exact idiom, no false-positive surface).
	const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ");
	if (FORK_BOMB_RE.test(normalized)) {
		return {
			rule: "fork-bomb",
			what: "fork bomb (:(){ :|:& };:)",
			why: "this idiom spawns processes exponentially until the host dies",
			next: "run your workload as plain sequential commands",
			where: "whole command",
		};
	}

	let script: UScript;
	try {
		const parsed = parse(command) as unknown as UScript & { errors?: unknown[] };
		if (parsed.errors && parsed.errors.length > 0) {
			return {
				rule: "parse-fail-closed",
				what: "command could not be parsed",
				why: "the bash guard walks a parsed AST — on parse errors it denies rather than guess (fail-closed)",
				next: "split the command into simpler statements the parser can read",
				where: "whole command",
			};
		}
		script = parsed;
	} catch {
		return {
			rule: "parse-fail-closed",
			what: "command could not be parsed",
			why: "the bash guard walks a parsed AST — on parse errors it denies rather than guess (fail-closed)",
			next: "split the command into simpler statements the parser can read",
			where: "whole command",
		};
	}

	const ctx: WalkCtx = {
		source: command,
		home: homeDirOf(opts),
		role: opts.role,
		writeAllowlist: opts.writeAllowlist ?? null,
		depth: 0,
		segIndex: 0,
	};
	return walkScript(script, 0, ctx);
}

/**
 * Default role write allowlist when settings.json carries no
 * subagentTypes.roleWriteAllowlist entry for the role. Read-heavy roles are
 * pinned to cwd + /tmp; write-capable roles and main are unrestricted;
 * unknown roles get /tmp only (default-deny floor for writes).
 */
export function defaultWriteAllowlist(role: string | undefined, cwd: string): WriteAllowlist {
	if (role === undefined || role === "") return ["/tmp"];
	if (role === "main" || role === "worker") return null;
	if (role === "researcher" || role === "scout") return [cwd, "/tmp"];
	return ["/tmp"];
}
