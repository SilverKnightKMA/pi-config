/**
 * lessons-core — pure functions for the global lessons tier (#1A direction 1).
 *
 * One lesson = one line: `[YYYY-MM-DD][tag] text`
 * tags: failure | correction | preference | convention (taxonomy borrowed
 * from @pify/memory, MIT — portable idea, no code copied).
 *
 * Doctrine (docs/designs/lessons-memory-tier.md):
 *  - OM consolidator is the SINGLE WRITER of ~/.pi/agent/lessons.md
 *    (via the OM worker subprocess, which memory-guard exempts).
 *  - The lessons extension is a pure INJECTOR: reads only, never writes,
 *    $0 model calls.
 *  - Secret-bearing lines are rejected at build time and never injected.
 */

export const LESSON_TAGS = ["failure", "correction", "preference", "convention"] as const;
export type LessonTag = (typeof LESSON_TAGS)[number];

export interface Lesson {
	date: string; // YYYY-MM-DD
	tag: LessonTag;
	text: string;
}

/** Default file location: ~/.pi/agent/lessons.md (HOME-aware; NOT under .memory/
 *  so memory-guard scope is untouched; NOT under ~/.pi/agent/memory/ so it can
 *  never collide with @pify/memory if upstream is installed some day). */
export function lessonsFilePath(env: NodeJS.ProcessEnv = process.env, home = process.env.HOME ?? ""): string {
	return env.LESSONS_FILE && env.LESSONS_FILE.trim() ? env.LESSONS_FILE : join(home, ".pi", "agent", "lessons.md");
}

// --- secret detection -------------------------------------------------------
// Small, conservative set — the OM worker's own scan is the authoritative gate
// upstream of us; this is the second fence (defense in depth) so a secret can
// never round-trip through injection after every compaction ("laundering").
const SECRET_PATTERNS: RegExp[] = [
	/sk-ant-[A-Za-z0-9_\-]{16,}/, // Anthropic
	/sk-proj-[A-Za-z0-9_\-]{16,}/, // OpenAI project key
	/ghp_[A-Za-z0-9]{20,}/, // GitHub PAT
	/gho_[A-Za-z0-9]{20,}/, // GitHub OAuth
	/github_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained
	/AKIA[0-9A-Z]{16}/, // AWS access key id
	/xox[baprs]-[A-Za-z0-9\-]+/, // Slack tokens
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
];

export function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((re) => re.test(text));
}

// --- parse -------------------------------------------------------------------

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2})\]\[(failure|correction|preference|convention)\] (.+)$/;

export function parseLessonsLine(line: string): Lesson | null {
	const m = LINE_RE.exec(line.trim());
	if (!m) return null;
	return { date: m[1], tag: m[2] as LessonTag, text: m[3].trim() };
}

export function parseLessonsFile(content: string): Lesson[] {
	const out: Lesson[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const lesson = parseLessonsLine(line);
		if (lesson && !containsSecret(lesson.text)) out.push(lesson);
	}
	return out;
}

export function formatLesson(lesson: Lesson): string {
	return `[${lesson.date}][${lesson.tag}] ${lesson.text}`;
}

/** Build a line for the global tier. Returns null when it must NOT be written:
 *  bad date, unknown tag, empty text, text that smuggles a secret. */
export function buildLessonLine(date: string, tag: LessonTag, text: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	if (!LESSON_TAGS.includes(tag)) return null;
	const t = text.trim();
	if (!t || t.length > 500 || t.includes("\n")) return null;
	if (containsSecret(t)) return null;
	return `[${date}][${tag}] ${t}`;
}

// --- recall (injector side) ---------------------------------------------------

export interface InjectionConfig {
	inject: boolean;
	maxLines: number;
	maxAgeDays: number;
}

function clampInt(raw: string | undefined, min: number, max: number, dflt: number): number {
	const n = raw ? Number.parseInt(raw, 10) : NaN;
	if (!Number.isFinite(n)) return dflt;
	return Math.max(min, Math.min(max, n));
}

export function injectionConfig(env: NodeJS.ProcessEnv = process.env): InjectionConfig {
	return {
		inject: env.LESSONS_INJECT !== "0",
		maxLines: clampInt(env.LESSONS_MAX_LINES, 1, 50, 8),
		maxAgeDays: clampInt(env.LESSONS_MAX_AGE_DAYS, 1, 365, 30),
	};
}

function daysBetween(dateStr: string, now: Date): number {
	const then = Date.parse(`${dateStr}T00:00:00Z`);
	if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
	// Calendar-day arithmetic (UTC): "exactly N days old" must not depend on
	// the wall-clock time inside `now` (12:00 vs 00:00 shifted the boundary
	// by a fractional day — caught by the 30d±1 test).
	return Math.floor(now.getTime() / 86_400_000) - Math.floor(then / 86_400_000);
}

/** Age filter — inclusive boundary: exactly maxAgeDays days old still passes,
 *  one day older drops. */
export function filterByAge(lessons: Lesson[], maxAgeDays: number, now = new Date()): Lesson[] {
	return lessons.filter((l) => daysBetween(l.date, now) <= maxAgeDays);
}

/** Newest N — file order is chronological (append-only), so take from the end.
 *  Same-date ties keep file order. */
export function newestN(lessons: Lesson[], n: number): Lesson[] {
	if (n <= 0) return [];
	return lessons.slice(Math.max(0, lessons.length - n));
}

export function renderLessonsBlock(lessons: Lesson[]): string {
	const lines = lessons.map(formatLesson).join("\n");
	return [
		"Lessons from past sessions (global tier, newest last, auto-injected — these cost nothing to keep):",
		lines,
	].join("\n");
}

// --- trim (writer side, OM consolidator) --------------------------------------

/** Hysteresis trim: only when the file has grown past `hysteresis` lines drop
 *  the oldest down to `cap` in one batch. Avoids per-append churn. */
export function trimLines(lines: string[], cap = 200, hysteresis = 232): string[] {
	if (lines.length <= hysteresis) return lines;
	return lines.slice(lines.length - cap);
}

// node:path join without importing node:path in the pure module? Keep it pure:
// tiny local join so tests never touch the fs.
function join(home: string, ...rest: string[]): string {
	const base = home.endsWith("/") ? home.slice(0, -1) : home;
	return [base, ...rest].join("/");
}
