/**
 * facts — durable memory tier PUSH injector (memory part 2 HYBRID, plan
 * 2026-09-21, step P1b / #175).
 *
 * Pure injector, same doctrine as lessons ext (v1.4.75): READS
 * ~/.pi/agent/facts.md, injects the selected block (P1→P2→P3, newest first,
 * ≤ maxLines lines / ≤ maxChars chars) as a hidden context message at
 * session_start — and re-injects after EVERY compaction so the block survives
 * context loss (recipe proven by @pify/memory 0.9.2's session_compact hook,
 * MIT — concept credit, no code copied).
 *
 * $0 model calls. Never writes the facts file — the deterministic regex
 * trigger (P2) and memory-curator (P3) are the only writers; the agent has no
 * write path here (P1d guard scope).
 *
 * Escape hatches (docs/escape-hatches.md):
 *   FACTS_INJECT=0        disable all injection
 *   FACTS_MAX_LINES=20    PUSH line budget (1-50)
 *   FACTS_MAX_CHARS=2048  PUSH char budget (256-4096)
 *   FACTS_FILE=<path>     file override (tests)
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { recallFacts, renderRecallReport } from "./src/recall.ts";
import {
	FACT_CATEGORIES,
	factsFilePath,
	factsInjectConfig,
	parseFactsFile,
	renderFactsBlock,
	selectFactsForInject,
	todayIso,
} from "./src/store.ts";

/** Read + select + render. Returns null when there is nothing to inject
 *  (missing file, empty, all tombstoned/expired, or injection disabled). */
export function buildFactsInjectionBlock(env: NodeJS.ProcessEnv, now: () => Date = () => new Date()): string | null {
	const cfg = factsInjectConfig(env);
	if (!cfg.inject) return null;
	let raw: string;
	try {
		raw = readFileSync(factsFilePath(env), "utf8");
	} catch {
		return null; // no file yet — first run, zero noise
	}
	const picked = selectFactsForInject(
		parseFactsFile(raw),
		{ maxLines: cfg.maxLines, maxChars: cfg.maxChars },
		todayIso(now),
	);
	if (picked.length === 0) return null;
	return renderFactsBlock(picked);
}

function injectNow(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
	const block = buildFactsInjectionBlock(env);
	if (block === null) return;
	// display:false — machine-injected context, participates in LLM context
	// but renders nothing in the TUI. No triggerTurn: injection must never
	// wake the model on its own.
	pi.sendMessage({ customType: "facts-context", content: block, display: false });
}

export default function factsExtension(pi: ExtensionAPI): void {
	// P1c (#176): PULL recall tool — keyword search over the durable tier.
	// Swap threshold (plan 2026-09-21): move to FTS5/BM25 when facts.md
	// exceeds ~100KB OR false-hit noise grows; grep-grade stays right until
	// then. Deterministic, read-only, $0 model calls.
	pi.registerTool({
		name: "facts_recall",
		label: "facts_recall",
		description:
			"Search the durable facts tier (~/.pi/agent/facts.md) — long-term user preferences, conventions, project and decision memory that survives across sessions. PASS 1 requires EVERY keyword to appear; falls back to ANY-keyword ranking when nothing matches all. Use when the injected Facts block does not cover the topic.",
		promptSnippet:
			"Use this tool to recall long-term facts (preferences, conventions, decisions) by keywords before assuming you do not know them.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Space-separated keywords. A fact matches when its text contains EVERY keyword (case-insensitive); when nothing matches all keywords, results containing ANY keyword are returned ranked, marked 'partial match'.",
			}),
			category: Type.Optional(
				Type.String({
					description: `Filter by category: ${FACT_CATEGORIES.join(" | ")}. Omit to search all categories.`,
				}),
			),
			include_tombstoned: Type.Optional(
				Type.Boolean({
					description: "Also search tombstoned (retired) facts — useful to check WHY a fact was retired (reason is shown as [dead:<reason>]). Default false.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			let raw: string;
			try {
				raw = readFileSync(factsFilePath(process.env), "utf8");
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `facts_recall: no facts file yet (${factsFilePath(process.env)}) — the durable tier is empty on this machine`,
						},
					],
					details: {},
				};
			}
			const text = renderRecallReport(
				recallFacts(parseFactsFile(raw), {
					query: String(params.query ?? ""),
					category: params.category ? String(params.category) : undefined,
					includeTombstoned: params.include_tombstoned === true,
				}),
			);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.on("session_start", () => {
		injectNow(pi, process.env);
	});
	// Re-inject after EVERY compaction — the session_start block lives in the
	// pre-compaction branch and is summarized away at the first compaction.
	// Re-read from disk, fresh values, deterministic, no model call.
	pi.on("session_compact", () => {
		injectNow(pi, process.env);
	});
}
