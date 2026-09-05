/**
 * snip — RPC-compatible port of amosblomqvist/pi-config prompt-snippets.
 *
 * Mix-and-match prompt rules wrapped around outgoing messages.
 *
 * Usage (Paseo-friendly; the TUI alt+s menu cannot render over RPC):
 *   /snip              → select dialog (numeric multi "1,3"); selection is
 *                        one-shot: applied to the NEXT message, then resets
 *                        (matches the original extension's behavior).
 *   /snip sticky       → selection persists for the session until /snip off.
 *   /snip off          → clear active snippets.
 *   /snip list         → show available snippets and the active set.
 *   /snip <ids>        → fast path, no dialog: "/snip 1,3" activates ids
 *                        directly (one-shot; "/snip sticky 1,3" to persist).
 *
 * State persistence: a custom session entry (customType "snip-state") is
 * appended on every change and replayed at session_start, so the active set
 * survives pi restarts and Paseo daemon restarts (session resume from .jsonl).
 * Custom entries never enter the LLM context.
 *
 * Transform: `on("input")` fires for every prompt source (interactive + RPC),
 * verified in agent-session.js:842 — prepend-group bodies + user text +
 * append-group bodies, same ordering as the original.
 *
 * Transparency: after each applied message the extension appends a custom
 * message ("Snippets applied: …") which Paseo renders on the timeline, so the
 * user sees which snippets rode the prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Snippet {
	id: string;
	name: string;
	description: string;
	placement: "prepend" | "append";
	order: number;
	body: string;
}

interface SnipState {
	/** ids of active snippets */
	active: string[];
	sticky: boolean;
}

/**
 * Control file (v1.5): the bridge the snip Paseo plugin uses to drive this
 * engine from a panel/composer pill. The plugin writes a request
 * {v:1, active, sticky, sentAt}; this extension watches the file, applies the
 * payload through the normal setState path (ledger entry + timeline notice),
 * then rewrites the file with ackAt so the pill can confirm the engine is live.
 * One file per session: ~/.pi/agent/snip-control/<sessionId>.json (outside the
 * extensions dir so sync-live never touches it).
 */
export interface SnipControlFile {
	v: 1;
	active: string[];
	sticky: boolean;
	/** set by the plugin on every request; echoed back on ack */
	sentAt?: string;
	/** set by this engine when a payload has been applied */
	ackAt?: string;
}

export function controlFilePath(sessionId: string): string {
	const home = process.env.PI_HOME ?? process.env.HOME ?? "/home/coder";
	return join(home, ".pi", "agent", "snip-control", `${sessionId}.json`);
}

/** Parse + validate a control payload. Returns null when malformed. */
export function parseControlPayload(raw: string): SnipControlFile | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	if (d.v !== 1 || !Array.isArray(d.active) || typeof d.sticky !== "boolean") return null;
	return {
		v: 1,
		active: d.active.filter((x): x is string => typeof x === "string"),
		sticky: d.sticky,
		sentAt: typeof d.sentAt === "string" ? d.sentAt : undefined,
		ackAt: typeof d.ackAt === "string" ? d.ackAt : undefined,
	};
}

const STATE_ENTRY_TYPE = "snip-state";
const APPLIED_MARKER_TYPE = "snip-applied";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const snippetsDir = join(extensionDir, "snippets");

/** Parse a snippet markdown file (frontmatter + body). Returns null if malformed. */
export function parseSnippet(filename: string, raw: string): Snippet | null {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return null;

	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
	}

	const body = match[2].trim();
	if (!body) return null;

	const parsedOrder = Number.parseInt(meta.order ?? "", 10);
	return {
		id: filename,
		name: meta.name || filename.replace(/\.md$/i, ""),
		description: meta.description ?? "",
		placement: meta.placement === "prepend" ? "prepend" : "append",
		order: Number.isFinite(parsedOrder) ? parsedOrder : 9999,
		body,
	};
}

/** Load all snippets: prepend group first, then append group, each by (order, name). */
export function loadSnippets(): Snippet[] {
	if (!existsSync(snippetsDir)) return [];
	const snippets: Snippet[] = [];
	for (const file of readdirSync(snippetsDir)) {
		if (!file.toLowerCase().endsWith(".md")) continue;
		try {
			const snippet = parseSnippet(file, readFileSync(join(snippetsDir, file), "utf-8"));
			if (snippet) snippets.push(snippet);
		} catch {
			// Skip unreadable files
		}
	}
	const byOrder = (a: Snippet, b: Snippet) => a.order - b.order || a.name.localeCompare(b.name);
	return [
		...snippets.filter((s) => s.placement === "prepend").sort(byOrder),
		...snippets.filter((s) => s.placement === "append").sort(byOrder),
	];
}

/** Wrap user text with active snippet bodies (same ordering as the original). */
export function applySnippets(snippets: Snippet[], activeIds: string[], text: string): string {
	const active = snippets.filter((s) => activeIds.includes(s.id));
	if (active.length === 0) return text;
	const prepends = active.filter((s) => s.placement === "prepend").map((s) => s.body);
	const appends = active.filter((s) => s.placement === "append").map((s) => s.body);
	return [...prepends, text, ...appends].join("\n\n");
}

/** Parse a numeric selection "1,3" against the display list; 0/blank = none. */
export function parseSelection(raw: string, snippets: Snippet[]): { ids: string[]; error?: string } {
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed === "0") return { ids: [] };
	const tokens = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
	const ids: string[] = [];
	for (const token of tokens) {
		if (!/^\d+$/.test(token)) return { ids: [], error: `not a number: "${token}"` };
		const index = parseInt(token, 10);
		if (index < 1 || index > snippets.length) {
			return { ids: [], error: `index ${index} out of range (1-${snippets.length})` };
		}
		const id = snippets[index - 1].id;
		if (!ids.includes(id)) ids.push(id);
	}
	return { ids };
}

/** Display list line for the select dialog (description embedded, RPC-safe). */
export function snippetLine(snippet: Snippet, index: number): string {
	const tag = snippet.placement === "prepend" ? "↑" : "↓";
	const desc = snippet.description ? ` — ${snippet.description}` : "";
	return `${index}. ${tag} ${snippet.name}${desc}`;
}

export default function snip(pi: ExtensionAPI) {
	let state: SnipState = { active: [], sticky: false };

	/** Session whose control file this process watches (set at session_start). */
	let sessionId = "";
	/** sentAt of the last payload applied via the control file (self-write dedupe). */
	let lastSentAtSeen: string | undefined;
	let watchDebounce: ReturnType<typeof setTimeout> | undefined;

	function writeControlFile(): void {
		if (!sessionId) return;
		const file = controlFilePath(sessionId);
		try {
			mkdirSync(dirname(file), { recursive: true });
			const payload: SnipControlFile = {
				v: 1,
				active: state.active,
				sticky: state.sticky,
				sentAt: lastSentAtSeen,
				ackAt: new Date().toISOString(),
			};
			const tmp = `${file}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify(payload), "utf8");
			renameSync(tmp, file);
		} catch {
			// best-effort: /snip command flow never depends on the file
		}
	}

	/** Apply a plugin-written payload (watch callback). */
	function consumeControlFile(): void {
		if (!sessionId) return;
		let payload: SnipControlFile | null = null;
		try {
			payload = parseControlPayload(readFileSync(controlFilePath(sessionId), "utf8"));
		} catch {
			return; // unreadable — nothing to apply
		}
		if (!payload) return;
		if (payload.sentAt && payload.sentAt === lastSentAtSeen) return; // our own ack echo
		lastSentAtSeen = payload.sentAt ?? `no-sentAt-${Date.now()}`;
		// Same-state rewrite (no-op change) — just refresh the ack.
		if (setsEqual(payload.active, state.active) && payload.sticky === state.sticky) {
			writeControlFile();
			return;
		}
		applyState({ active: payload.active, sticky: payload.sticky });
	}

	function setsEqual(a: string[], b: string[]): boolean {
		return a.length === b.length && a.every((x) => b.includes(x));
	}

	/** Core state change: ledger entry + control file + timeline notice. */
	function applyState(next: SnipState): void {
		state = next;
		pi.appendEntry(STATE_ENTRY_TYPE, next);
		writeControlFile();
		announceActive();
	}

	/** "Loaded up here": timeline message rendered by Paseo (notify drops mid-turn). */
	function announceActive(): void {
		const snippets = loadSnippets();
		const names = state.active.map((id) => snippets.find((s) => s.id === id)?.name ?? id);
		const text = state.active.length === 0
			? "📝 Snippets: none active"
			: `📝 Snippets ${state.sticky ? "(sticky) " : ""}armed: ${names.join(", ")}${state.sticky ? "" : " — applies to your next message"}`;
		pi.sendMessage({ customType: "snip-status", content: text, display: true });
	}

	function setState(next: SnipState, ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }): void {
		applyState(next);
		const snippets = loadSnippets();
		const names = next.active.map((id) => snippets.find((s) => s.id === id)?.name ?? id);
		const text = next.active.length === 0
			? "📝 Snippets: none active"
			: `📝 Snippets ${next.sticky ? "(sticky) " : ""}armed: ${names.join(", ")}${next.sticky ? "" : " — applies to your next message"}`;
		ctx.ui.notify(text, "info");
	}

	// --- State restoration at session start -----------------------------------
	pi.on("session_start", (_event, ctx) => {
		let last: SnipState | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
				const candidate = entry.data as SnipState | undefined;
				if (candidate && Array.isArray(candidate.active)) {
					last = { active: candidate.active, sticky: candidate.sticky === true };
				}
			}
		}
		if (last) state = last;
		if (!existsSync(snippetsDir)) mkdirSync(snippetsDir, { recursive: true });

		// v1.5 plugin bridge: publish current state + watch for plugin requests.
		sessionId = (ctx.sessionManager.getSessionId?.() as string | undefined) ?? "";
		if (sessionId) {
			writeControlFile();
			try {
				const watcher = watch(dirname(controlFilePath(sessionId)), (event, filename) => {
					if (!filename || !filename.endsWith(`${sessionId}.json`)) return;
					if (watchDebounce) clearTimeout(watchDebounce);
					watchDebounce = setTimeout(() => {
						watchDebounce = undefined;
						consumeControlFile();
					}, 150);
				});
				watcher.on("error", () => {
					// best-effort — /snip commands never depend on the watcher
				});
			} catch {
				// watch unsupported (exotic fs) — panel stays read-only
			}
		}
	});

	// The applied ids are stashed so turn_end can write a transparency marker
	// to the transcript (Paseo renders it on the timeline).
	let lastApplied: string[] | undefined;
	pi.on("input", async (event, ctx) => {
		if (state.active.length === 0) return;

		const snippets = loadSnippets();
		const text = applySnippets(snippets, state.active, event.text);
		lastApplied = [...state.active];

		// One-shot mode resets after the first applied message (original behavior).
		if (!state.sticky) {
			setState({ active: [], sticky: false }, ctx);
		}
		return {
			action: "transform",
			text,
		};
	});

	// Record applied snippets on the transcript for user transparency.
	pi.on("turn_end", async (_event, ctx) => {
		if (!lastApplied || lastApplied.length === 0) return;
		const applied = lastApplied;
		lastApplied = undefined;
		const snippets = loadSnippets();
		const names = applied.map((id) => snippets.find((s) => s.id === id)?.name ?? id);
		pi.sendMessage({
			customType: APPLIED_MARKER_TYPE,
			content: `📝 Snippets applied: ${names.join(", ")}`,
			display: true,
		});
	});

	// --- Command surface -------------------------------------------------------
	pi.registerCommand("snip", {
		description: "Guided snippet setup: mode → prepend → append (3 quick dialogs), or fast paths",
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0]?.toLowerCase();

			if (sub === "off") {
				setState({ active: [], sticky: false }, ctx);
				return;
			}

			if (sub === "list") {
				const snippets = loadSnippets();
				const lines = snippets.map((s, i) => {
					const mark = state.active.includes(s.id) ? "[x]" : "[ ]";
					return `${mark} ${snippetLine(s, i + 1)}`;
				});
				ctx.ui.notify(lines.join("\n") || "No snippets found", "info");
				return;
			}

			// Fast paths (power users): "/snip 1,3" / "/snip sticky 1,3".
			const sticky = sub === "sticky";
			const idArg = sticky ? argv[1] : argv[0];
			if (sub !== undefined && !sticky && sub !== "on" && sub !== "setup") {
				// unknown subcommand → treat as numeric fast path only if it parses
				if (idArg === undefined) {
					ctx.ui.notify(`Unknown subcommand "${sub}". Use /snip (guided), /snip <ids>, /snip sticky <ids>, /snip off, /snip list`, "warning");
					return;
				}
			}
			if (idArg !== undefined && idArg !== sub) {
				const snippets = loadSnippets();
				const parsed = parseSelection(idArg, snippets);
				if (parsed.error) {
					ctx.ui.notify(`Invalid selection: ${parsed.error}`, "warning");
					return;
				}
				setState({ active: parsed.ids, sticky }, ctx);
				return;
			}

			const snippets = loadSnippets();
			if (snippets.length === 0) {
				ctx.ui.notify(`No snippets found in ${snippetsDir}`, "warning");
				return;
			}
			const prepends = snippets.filter((s) => s.placement === "prepend");
			const appends = snippets.filter((s) => s.placement === "append");

			// ── Dialog 1/3: mode ─────────────────────────────────────────
			const modeAnswer = await ctx.ui.select(
				[
					"Snippets — 1/3: mode",
					"",
					"How long should the selection apply?",
				].join("\n"),
				[
					"One-shot — applies to my next message only, then resets",
					"Sticky — stays active for the rest of this session",
				],
			);
			if (modeAnswer === undefined) return; // dismissed
			const useSticky = modeAnswer.startsWith("Sticky");

			// ── Dialog 2/3: prepend group ────────────────────────────────
			const prependSelection = await askGroupSelection(ctx, "2/3", "PREPEND — added BEFORE your message", prepends);
			if (prependSelection.cancelled) return;

			// ── Dialog 3/3: append group ─────────────────────────────────
			const appendSelection = await askGroupSelection(ctx, "3/3", "APPEND — added AFTER your message", appends);
			if (appendSelection.cancelled) return;

			const active = [...prependSelection.ids, ...appendSelection.ids];



			setState({ active, sticky: useSticky }, ctx);
		},
	});
}


/**
 * Parse the combined two-group answer "<prepend#s> | <append#s>".
 * Missing pipe → everything is treated as prepend selection.
 * Invalid numbers are skipped silently (the dialog text explains the format).
 */
export function parseTwoGroupSelection(
	raw: string,
	prepends: Snippet[],
	appends: Snippet[],
): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const [prePart, postPart] = trimmed.includes("|") ? trimmed.split("|", 2) : [trimmed, ""];
	const ids: string[] = [];
	for (const token of prePart.split(",")) {
		const n = parseInt(token.trim(), 10);
		if (Number.isInteger(n) && n >= 1 && n <= prepends.length && !ids.includes(prepends[n - 1].id)) {
			ids.push(prepends[n - 1].id);
		}
	}
	for (const token of (postPart ?? "").split(",")) {
		const n = parseInt(token.trim(), 10);
		if (Number.isInteger(n) && n >= 1 && n <= appends.length && !ids.includes(appends[n - 1].id)) {
			ids.push(appends[n - 1].id);
		}
	}
	return ids;
}

/** One group-selection dialog: numbered list + numeric multi answer. */
export async function askGroupSelection(
	ctx: { ui: { input: (title: string, placeholder?: string) => Promise<string | undefined>; notify: (m: string, t?: "info" | "warning" | "error") => void } },
	step: string,
	kind: string,
	group: Snippet[],
): Promise<{ ids: string[]; cancelled: boolean }> {
	if (group.length === 0) {
		return { ids: [], cancelled: false }; // empty group → skip silently
	}
	const lines = [
		`Snippets — step ${step}: ${kind}`,
		"",
		...group.map((s, i) => `${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ""}`),
		"",
		`Reply with number(s) separated by "," — e.g. ${group.length > 1 ? `1,${Math.min(2, group.length)}` : "1"}. Empty or 0 = none from this group.`,
	].join("\n").replace("+\t\t", "");
	const raw = await ctx.ui.input(lines, `numbers, or empty for none`);
	if (raw === undefined) return { ids: [], cancelled: true }; // dismissed
	const parsed = parseSelection(raw, group);
	if (parsed.error) {
		ctx.ui.notify(`Invalid selection: ${parsed.error} — group skipped (no ${kind.split(" ")[0].toLowerCase()} snippets)`, "warning");
		return { ids: [], cancelled: false };
	}
	return { ids: parsed.ids, cancelled: false };
}
