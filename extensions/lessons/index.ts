/**
 * lessons — global memory tier injector (#1A direction 1, plan 2026-09-15).
 *
 * Pure injector: READS ~/.pi/agent/lessons.md, injects the newest N=8 lessons
 * (≤30 days old) as a hidden context message at session_start — and (part ②,
 * v1.4.75) re-injects after EVERY compaction so the block survives context
 * loss (recipe proven by @pify/memory 0.9.2's session_compact hook, MIT).
 *
 * $0 model calls. Never writes the lessons file — OM consolidator is the
 * single writer (memory-guard scope untouched; agent has no write tool here).
 *
 * Escape hatches (docs/escape-hatches.md):
 *   LESSONS_INJECT=0        disable all injection
 *   LESSONS_MAX_LINES=8     newest-N recall
 *   LESSONS_MAX_AGE_DAYS=30 age filter
 *   LESSONS_FILE=<path>     file override (tests)
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	injectionConfig,
	lessonsFilePath,
	filterByAge,
	newestN,
	parseLessonsFile,
	renderLessonsBlock,
} from "../_shared/lessons-core.ts";

/** Read + select + render. Returns null when there is nothing to inject
 *  (missing file, empty, all stale, or injection disabled). */
function buildInjectionBlock(env: NodeJS.ProcessEnv): string | null {
	const cfg = injectionConfig(env);
	if (!cfg.inject) return null;
	let raw: string;
	try {
		raw = readFileSync(lessonsFilePath(env), "utf8");
	} catch {
		return null; // no file yet — first run, zero noise
	}
	const lessons = filterByAge(parseLessonsFile(raw), cfg.maxAgeDays);
	const picked = newestN(lessons, cfg.maxLines);
	if (picked.length === 0) return null;
	return renderLessonsBlock(picked);
}

function injectNow(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
	const block = buildInjectionBlock(env);
	if (block === null) return;
	// display:false — machine-injected context, participates in LLM context
	// but renders nothing in the TUI (same mechanism @pify/memory uses).
	// No triggerTurn: injection must never wake the model on its own.
	pi.sendMessage({ customType: "lessons-context", content: block, display: false });
}

export default function lessonsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		injectNow(pi, process.env);
	});
	// Part ② (plan step 4): re-inject after EVERY compaction. The block injected
	// at session_start lives in the pre-compaction branch and is summarized
	// away at the first compaction; without this hook a long session forgets its
	// lessons exactly when context pressure is highest. Recipe proven by
	// @pify/memory 0.9.2's session_compact handler (MIT): re-read from disk,
	// fresh values, deterministic, no model call.
	pi.on("session_compact", () => {
		injectNow(pi, process.env);
	});
}
