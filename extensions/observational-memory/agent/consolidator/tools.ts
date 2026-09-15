/**
 * The consolidator's tool belt. v1.4.56 default is the STAGING CONTRACT: the model never
 * touches topic files — it submits dated sections (`submit_sections`, the engine appends them
 * and maintains front-matter/INDEX) and rewrites the whole JOURNEY under a budget gate
 * (`write_journey`, rejected when over-budget so the old file is never lost to mechanical
 * truncation). There are deliberately NO read/grep/ls/edit tools: past runs burned 28 greps and
 * 16 failed edits because anchors lived in file tails the prompt never showed.
 *
 * Escape hatches:
 * - `OM_CONSOLIDATOR_V2=0` restores the legacy scoped read/write/edit/ls/grep belt.
 * - `OM_COMPACT_FILE=<slug>.md` (set by the orchestrator's >200KB valve) registers exactly one
 *   `write_full_file` tool jailed to that single file for the mini compaction job.
 *
 * Scoping: every path argument is resolved against OM_MEMORY_DIR and rejected if it escapes
 * that directory, so a wayward model cannot read or clobber the user's project.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { atomicWrite } from "../../src/memory/paths.js";
import { applyStagedSections, checkJourneyBudget, normalizeTarget } from "./staging.js";
import { buildLessonLine, lessonsFilePath, trimLines } from "../../../_shared/lessons-core.ts";

type ToolText = { content: { type: "text"; text: string }[]; details: unknown };

function ok(text: string, details: unknown = {}): ToolText {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string): ToolText {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } };
}

/** Resolve a requested path against the sandbox root, or return undefined if it escapes.
 *
 * Path normalization: the system prompt and tool docs describe files as living "under .memory/",
 * so the model often writes `.memory/auth.md`. The sandbox root IS the memory dir, so a literal
 * `.memory/` prefix would nest one level too deep (root/.memory/auth.md) and topic files would
 * vanish from INDEX.md (bug seen 2026-08-30: "No topics yet" while topics existed nested).
 * Strip any leading `./` and `.memory/` prefix so both spellings resolve to the same file. */
function scoped(root: string, requested: string): string | undefined {
	const normalized = requested.replace(/^[.]\//, "").replace(/^\.memory\//, "");
	const abs = resolve(root, normalized);
	const rel = relative(root, abs);
	if (rel === "") return abs;
	if (rel.startsWith("..")) return undefined;
	return abs;
}

const ReadSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/, e.g. 'auth.md' or '.memory/auth.md'." }),
});
const WriteSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/ to (over)write, e.g. 'auth.md'." }),
	content: Type.String({ description: "Full file content, including YAML front-matter." }),
});
const EditSchema = Type.Object({
	path: Type.String({ description: "Path inside .memory/ to edit." }),
	oldText: Type.String({ description: "Exact text to replace (must occur exactly once)." }),
	newText: Type.String({ description: "Replacement text." }),
});
const LsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Subdirectory inside .memory/. Defaults to .memory/ root." })),
});
const GrepSchema = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression to search for." }),
	path: Type.Optional(Type.String({ description: "Restrict to this file/subdir inside .memory/." })),
});

const SubmitSchema = Type.Object({
	sections: Type.Array(
		Type.Object({
			target: Type.String({
				description: "Root-level topic filename, e.g. 'user-preferences.md'. Flat, one level — no paths.",
			}),
			section: Type.String({
				description:
					"New section body (plain markdown, no front-matter). The engine prepends the '## <date> (batch …)' heading and appends it to the file.",
			}),
			summary: Type.Optional(
				Type.String({ description: "New one-line index summary (≤140 chars); replaces the front-matter summary." }),
			),
		}),
		{ minItems: 1 },
	),
});
const WriteJourneySchema = Type.Object({
	content: Type.String({ description: "The FULL new JOURNEY.md body (no front-matter), within the word budget from your prompt." }),
});
const WriteFullFileSchema = Type.Object({
	content: Type.String({ description: "The FULL rewritten file body, starting with its front-matter block." }),
});
const RecordLessonSchema = Type.Object({
	tag: Type.Union(
		[Type.Literal("failure"), Type.Literal("correction"), Type.Literal("preference"), Type.Literal("convention")],
		{ description: "failure = a mode to avoid; correction = supersedes a wrong earlier claim; preference = user's standing choice; convention = house rule." },
	),
	text: Type.String({
		description:
			"One durable lesson in plain prose, ≤500 chars, no secrets/tokens. It is injected into EVERY future session — record sparingly, only what stays true.",
	}),
});

type ReadInput = Static<typeof ReadSchema>;
type WriteInput = Static<typeof WriteSchema>;
type EditInput = Static<typeof EditSchema>;
type LsInput = Static<typeof LsSchema>;
type GrepInput = Static<typeof GrepSchema>;
type SubmitInput = Static<typeof SubmitSchema>;
type WriteJourneyInput = Static<typeof WriteJourneySchema>;
type RecordLessonInput = Static<typeof RecordLessonSchema>;

/** Global lessons tier (#1A): append one validated line to ~/.pi/agent/lessons.md
 *  (or LESSONS_FILE). The consolidator worker is the SINGLE WRITER; date is
 *  engine-stamped (never model-supplied); buildLessonLine rejects empty /
 *  >500-char / secret-shaped text; trimLines applies the 232→200 hysteresis so
 *  the file can never grow unbounded. The lessons extension (pure injector)
 *  reads this file at session_start and re-injects after every compaction. */
function appendGlobalLesson(params: RecordLessonInput): ToolText {
	const at = new Date().toISOString().slice(0, 10);
	const line = buildLessonLine(at, params.tag, params.text);
	if (!line) {
		return fail(
			`lesson rejected — WHAT: a [${params.tag}] lesson line. WHY: empty, over 500 chars, multiline, or secret-shaped (tokens/keys are never written to the global tier). NEXT: restate the lesson in plain prose under 500 chars with no credentials, then call record_lesson again.`,
		);
	}
	const file = lessonsFilePath(process.env);
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${line}\n`);
		const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
		const trimmed = trimLines(lines);
		if (trimmed.length !== lines.length) {
			atomicWrite(file, `${trimmed.join("\n")}\n`);
		}
		return ok(`lesson recorded → global tier (${trimmed.length} lines): ${line}`, { line, lines: trimmed.length });
	} catch (e) {
		return fail(`global tier write failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
type WriteFullFileInput = Static<typeof WriteFullFileSchema>;

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue; // skip .runs and temp files
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

/** Register the tool belt for the consolidator worker. Dispatches on env (see header). */
export function registerConsolidatorTools(pi: ExtensionAPI, memoryRoot: string): void {
	const root = resolve(memoryRoot);
	if (process.env.OM_CONSOLIDATOR_V2 === "0") {
		registerLegacyTools(pi, root);
		return;
	}
	const compactFile = process.env.OM_COMPACT_FILE;
	if (compactFile) {
		registerCompactTools(pi, root, compactFile);
		return;
	}
	registerStagingTools(pi, root);
}

/** v1.4.56 staging belt: exactly two tools, no exploration, no direct topic writes. */
function registerStagingTools(pi: ExtensionAPI, root: string): void {
	const journeyTargetTokens = Number(process.env.OM_JOURNEY_TOKENS ?? "1000");

	pi.registerTool({
		name: "submit_sections",
		label: "Submit topic sections",
		description:
			"Submit new dated sections, one per topic that changes. The engine appends each to its file and maintains front-matter + INDEX — you never write topic files directly.",
		parameters: SubmitSchema,
		async execute(_id: string, params: SubmitInput): Promise<ToolText> {
			const at = new Date().toISOString().slice(0, 16);
			const outcome = applyStagedSections(root, process.env.OM_RUN_ID ?? "manual", at, params.sections);
			const lines: string[] = [];
			for (const a of outcome.applied) lines.push(`applied → ${a.target}${a.created ? " (created)" : ""}`);
			for (const r of outcome.rejected) lines.push(`REJECTED ${r.target}: ${r.reason}`);
			if (outcome.applied.length === 0) {
				return fail(`no section applied:\n${lines.join("\n")}`);
			}
			return ok(lines.join("\n"), outcome);
		},
	});

	pi.registerTool({
		name: "write_journey",
		label: "Rewrite JOURNEY.md",
		description:
			"Rewrite the whole JOURNEY.md. Rejected when over the word budget — compress the older history further and resubmit; the current file is never modified on rejection.",
		parameters: WriteJourneySchema,
		async execute(_id: string, params: WriteJourneyInput): Promise<ToolText> {
			const gate = checkJourneyBudget(params.content, journeyTargetTokens);
			if (!gate.ok) {
				return fail(
					`JOURNEY over budget: ${gate.words} words > ${gate.budget} (over by ${gate.overBy}). ` +
						"Compress the older headings further — keep the newest section intact — and submit again.",
				);
			}
			const body = params.content.endsWith("\n") ? params.content : `${params.content}\n`;
			atomicWrite(join(root, "JOURNEY.md"), body);
			return ok(`JOURNEY.md rewritten (${gate.words}/${gate.budget} words).`, gate);
		},
	});

	pi.registerTool({
		name: "record_lesson",
		label: "Record a global lesson",
		description:
			"Append ONE line to the global cross-session lessons tier (~/.pi/agent/lessons.md) that every future session reads at start and after each compaction. Only for lessons that stay true across ALL future sessions; the engine stamps the date and rejects secrets. Record sparingly.",
		parameters: RecordLessonSchema,
		async execute(_id: string, params: RecordLessonInput): Promise<ToolText> {
			return appendGlobalLesson(params);
		},
	});
}

/** >200KB valve mini-job: exactly one tool, jailed to the single file under compaction. */
function registerCompactTools(pi: ExtensionAPI, root: string, filename: string): void {
	const target = normalizeTarget(filename) ?? filename; // engine-supplied slug; jail still applies
	pi.registerTool({
		name: "write_full_file",
		label: `Rewrite ${target}`,
		description: "Rewrite this one topic file in full (front-matter + tightened body). This is the only tool you have.",
		parameters: WriteFullFileSchema,
		async execute(_id: string, params: WriteFullFileInput): Promise<ToolText> {
			const abs = scoped(root, target);
			if (!abs) return fail("path escapes .memory/");
			if (!params.content.trim().startsWith("---")) {
				return fail("content must start with the front-matter block");
			}
			atomicWrite(abs, params.content);
			return ok(`Rewrote ${target} (${params.content.length} bytes).`);
		},
	});
}

/** Legacy belt (v1.4.54 and earlier): scoped read/write/edit/ls/grep. Behind OM_CONSOLIDATOR_V2=0. */
function registerLegacyTools(pi: ExtensionAPI, root: string): void {
	pi.registerTool({
		name: "read",
		label: "Read memory file",
		description: "Read a topic file under .memory/.",
		parameters: ReadSchema,
		async execute(_id: string, params: ReadInput): Promise<ToolText> {
			const abs = scoped(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
			return ok(readFileSync(abs, "utf-8"));
		},
	});

	pi.registerTool({
		name: "write",
		label: "Write memory file",
		description: "Create or overwrite a topic file under .memory/ (atomic). Do not write INDEX.md.",
		parameters: WriteSchema,
		async execute(_id: string, params: WriteInput): Promise<ToolText> {
			const abs = scoped(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			if (/(^|\/)INDEX\.md$/i.test(params.path)) return fail("INDEX.md is generated automatically; do not write it");
			atomicWrite(abs, params.content);
			return ok(`Wrote ${params.path} (${params.content.length} bytes).`);
		},
	});

	pi.registerTool({
		name: "edit",
		label: "Edit memory file",
		description: "Replace an exact substring in a topic file under .memory/ (atomic).",
		parameters: EditSchema,
		async execute(_id: string, params: EditInput): Promise<ToolText> {
			const abs = scoped(root, params.path);
			if (!abs) return fail("path escapes .memory/");
			if (/(^|\/)INDEX\.md$/i.test(params.path)) return fail("INDEX.md is generated automatically; do not edit it");
			if (!existsSync(abs)) return fail(`no such file: ${params.path}`);
			const current = readFileSync(abs, "utf-8");
			const occurrences = current.split(params.oldText).length - 1;
			if (occurrences === 0) return fail("oldText not found");
			if (occurrences > 1) return fail(`oldText is ambiguous (${occurrences} matches); add more context`);
			atomicWrite(abs, current.replace(params.oldText, params.newText));
			return ok(`Edited ${params.path}.`);
		},
	});

	pi.registerTool({
		name: "ls",
		label: "List memory files",
		description: "List files under .memory/.",
		parameters: LsSchema,
		async execute(_id: string, params: LsInput): Promise<ToolText> {
			const abs = scoped(root, params.path ?? ".");
			if (!abs) return fail("path escapes .memory/");
			if (!existsSync(abs)) return ok("(.memory/ is empty)");
			const entries = readdirSync(abs).filter((n) => !n.startsWith("."));
			return ok(entries.length > 0 ? entries.sort().join("\n") : "(empty)");
		},
	});

	pi.registerTool({
		name: "grep",
		label: "Search memory files",
		description: "Search topic files under .memory/ with a regular expression.",
		parameters: GrepSchema,
		async execute(_id: string, params: GrepInput): Promise<ToolText> {
			let re: RegExp;
			try {
				re = new RegExp(params.pattern);
			} catch (e) {
				return fail(`invalid regex: ${(e as Error).message}`);
			}
			const base = scoped(root, params.path ?? ".");
			if (!base) return fail("path escapes .memory/");
			if (!existsSync(base)) return ok("(no matches)");
			const files = statSync(base).isDirectory() ? listFilesRecursive(base) : [base];
			const hits: string[] = [];
			for (const file of files) {
				const lines = readFileSync(file, "utf-8").split("\n");
				const relPath = relative(root, file);
				lines.forEach((line, i) => {
					if (re.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
				});
				if (hits.length >= 200) break;
			}
			return ok(hits.length > 0 ? hits.join("\n") : "(no matches)");
		},
	});
}
