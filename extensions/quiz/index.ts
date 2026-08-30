/**
 * quiz — RPC-compatible fork of amosblomqvist/learn quiz extension.
 *
 * Same tool contract and grading semantics as the original:
 *   - options-only (no free-text), correct answer keyed by VALUE not position
 *   - Fisher-Yates shuffle before display (default on); indices resolved after
 *   - "I don't know" is an explicit, non-gradable signal (exclusive in multi)
 *   - optional free-text note, surfaced only when non-empty
 *   - onUpdate fires the post-shuffle display order before blocking (md-log)
 *
 * UI layer uses only RPC-safe methods (pi 0.84 `--mode rpc`):
 *   - select(title, options)          single-select (+ "I don't know" row)
 *   - input(title, placeholder)       multi-select as numeric "1,3" + note
 *   - notify(message)                 post-answer feedback (verdict + correct
 *                                     answer + explanation) — the TUI feedback
 *                                     screen cannot render over RPC.
 *
 * Differences from the original (deliberate):
 *   1. Option descriptions are embedded into labels ("label — description").
 *   2. Multi-select is free-form numeric selection, parsed and validated here;
 *      invalid input re-prompts (bounded). "I don't know" is the sentinel index
 *      options.length + 1 and is exclusive: its presence discards other picks.
 *   3. The always-present inline note field becomes a follow-up input() dialog
 *      after the answer; empty or dismissed → no note (the answer is kept).
 *   4. The feedback phase becomes a notify() instead of a blocking TUI screen.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types (identical to original)
// ---------------------------------------------------------------------------

interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

interface OptionAnswer {
	label: string;
	value: string;
	index: number; // 1-based, matches the number shown to the user
}

interface QuizResponse {
	dontKnow: boolean;
	note?: string;
	answers: OptionAnswer[];
}

type QuizStatus = "answered" | "cancelled" | "unavailable";
type QuizMode = "single-select" | "multi-select";

interface DisplayedOption {
	index: number;
	label: string;
}

interface QuizResultDetails {
	status: QuizStatus;
	question: string;
	context?: string;
	mode: QuizMode;
	answers: OptionAnswer[];
	correctIndices: number[];
	options?: DisplayedOption[];
	correct?: boolean;
	dontKnow?: boolean;
	note?: string;
	explanation?: string;
	message?: string;
}

/** Minimal structural view of the extension ctx we rely on. */
interface ToolContext {
	hasUI: boolean;
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		notify: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

const DONT_KNOW_VALUE = "__dont_know__";
const DONT_KNOW_LABEL = "I don't know";

// ---------------------------------------------------------------------------
// Schema (identical to original)
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the answer option." }),
	value: Type.Optional(
		Type.String({ description: "Optional machine-readable value returned for the option. Defaults to the label." }),
	),
	description: Type.Optional(
		Type.String({ description: "Optional extra detail shown below the option." }),
	),
});

const QuizParams = Type.Object({
	question: Type.String({
		description: "The single quiz question to ask. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Array(OptionSchema, {
		description:
			"The answer options (2 or more). Options only — there is no free-text mode. Give each option a stable `value`; you reference the correct one by that value in correctAnswer.",
		minItems: 2,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true when more than one option is correct and the user must select all of them.",
		}),
	),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			'REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); the user is only correct if their selection matches this set exactly. Always pass the value, not a position number — this is self-checking and prevents miscounting.',
	}),
	explanation: Type.String({
		description:
			"REQUIRED. Explanation revealed AFTER the user answers (shown whether they got it right or wrong). Use it to reinforce why the correct answer is correct.",
	}),
	shuffle: Type.Optional(
		Type.Boolean({
			description:
				"Defaults to true: options are randomly reordered before display so the correct answer isn't always in the same position. Set to false only when option order is meaningful (e.g. ordered numeric values, or an 'All/None of the above' option that must stay last).",
		}),
	),
});

// ---------------------------------------------------------------------------
// Pure logic (identical to original)
// ---------------------------------------------------------------------------

function normalizeOptions(
	options: Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
	const seen = new Set<string>();
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => {
			if (option.label.length === 0) return false;
			if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`);
			seen.add(option.value);
			return true;
		});
}

/** Fisher-Yates over a copy; safe because grading is keyed by value. */
export function shuffleOptions(options: QuizOption[]): QuizOption[] {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Unwrap a JSON-stringified multi-select array; wrap a single value as-is. */
export function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
	if (Array.isArray(correctAnswer)) return correctAnswer;
	const trimmed = correctAnswer.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map((v) => String(v));
		} catch {
			// Not valid JSON — treat as a single literal value.
		}
	}
	return [correctAnswer];
}

export function resolveCorrect(
	correctAnswer: string | string[] | undefined,
	options: QuizOption[],
): { indices: number[]; error?: string } {
	if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
	const arr = coerceCorrectAnswer(correctAnswer);
	if (arr.length === 0) return { indices: [], error: "correctAnswer is required" };
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices: number[] = [];
	for (const raw of arr) {
		const v = typeof raw === "string" ? raw.trim() : raw;
		const idx = byValue.get(v);
		if (idx === undefined) {
			const known = options.map((o) => `"${o.value}"`).join(", ");
			return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
		}
		indices.push(idx);
	}
	return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}

export function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// Result builders (identical semantics to original)
// ---------------------------------------------------------------------------

function buildStructuredResult(
	status: QuizStatus,
	question: string,
	mode: QuizMode,
	answers: OptionAnswer[],
	correctIndices: number[],
	correct: boolean | undefined,
	explanation: string | undefined,
	context?: string,
	message?: string,
	options?: DisplayedOption[],
	dontKnow?: boolean,
	note?: string,
): QuizResultDetails {
	return { status, question, context, mode, answers, correctIndices, options, correct, dontKnow, note, explanation, message };
}

function cancelledResult(question: string, mode: QuizMode, correctIndices: number[], context?: string) {
	const message = "User cancelled the quiz";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], correctIndices, undefined, undefined, context, message),
	};
}

function unavailableResult(question: string, mode: QuizMode, message: string, correctIndices: number[], context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], correctIndices, undefined, undefined, context, message),
	};
}

function formatOptionRef(options: QuizOption[], index: number): string {
	const opt = options.find((o, i) => i + 1 === index);
	return `${index}. ${opt ? opt.label : "(unknown)"}`;
}

function buildResult(
	question: string,
	context: string | undefined,
	mode: QuizMode,
	options: QuizOption[],
	response: QuizResponse,
	correctIndices: number[],
	explanation: string | undefined,
) {
	const { dontKnow, note, answers } = response;
	const selectedIndices = answers.map((a) => a.index);
	const correct = dontKnow ? false : isCorrect(selectedIndices, correctIndices);
	const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
	const displayedOptions: DisplayedOption[] = options.map((o, i) => ({ index: i + 1, label: o.label }));

	let text: string;
	if (dontKnow) {
		text = `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).`;
		text += `\nCorrect: ${correctStr}`;
		if (note) text += `\nUser's note: ${note}`;
	} else {
		const verdict = correct ? "correctly" : "incorrectly";
		const selectedStr = answers.map((a) => `${a.index}. ${a.label}`).join(", ");
		text = `User answered ${verdict}.\nSelected: ${selectedStr}\nCorrect: ${correctStr}`;
		if (note) text += `\nUser's note: ${note}`;
	}
	if (explanation) text += `\nExplanation: ${explanation}`;

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult(
			"answered",
			question,
			mode,
			answers,
			correctIndices,
			correct,
			explanation,
			context,
			undefined,
			displayedOptions,
			dontKnow,
			note,
		),
	};
}

// ---------------------------------------------------------------------------
// RPC-safe UI layer
// ---------------------------------------------------------------------------

/** Collapse label + description into one string: "label — description". */
export function toDisplayLabel(option: QuizOption): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

function dialogTitle(question: string, context: string | undefined): string {
	return context ? `${question}\n\n${context}` : question;
}

/** Build the post-answer feedback text (shown to the user). */
function buildFeedbackText(
	options: QuizOption[],
	selectedIndices: number[],
	correctIndices: number[],
	explanation: string | undefined,
	dontKnow: boolean,
): string {
	const correct = !dontKnow && isCorrect(selectedIndices, correctIndices);
	const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
	const lines: string[] = [];
	if (dontKnow) {
		lines.push("🤷 I don't know — a knowledge gap, not a wrong guess.");
	} else {
		lines.push(correct ? "✓ Correct!" : "✗ Incorrect.");
	}
	lines.push(`Correct: ${correctStr}`);
	if (explanation) lines.push(`— ${explanation}`);
	return lines.join("\n");
}

/**
 * Post-answer follow-up: shows the graded feedback in the dialog title, then
 * collects the optional note in the same dialog. The title is the only
 * user-visible delivery channel that survives pi→Paseo RPC mid-turn (notify
 * events are dropped while a turn is active), so the feedback rides here.
 *
 * CAUTION: the placeholder must NOT contain the words "optional" or "skip" —
 * the Paseo host replaces the whole dialog title with "Optional response"
 * when its placeholder heuristic matches those words.
 */
async function askNoteWithFeedback(
	ctx: ToolContext,
	question: string,
	feedbackText: string,
): Promise<string | undefined> {
	const title = `${feedbackText}\n\n${question} — add a note?`;
	// Best-effort duplicate delivery; harmless when dropped by the host.
	ctx.ui.notify(feedbackText, "info");
	const raw = await ctx.ui.input(title, "Type a note or leave blank — Enter to continue");
	const trimmed = raw?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Single-select via one select() call. "I don't know" rides as the last row.
 * Then one input() that shows the graded feedback in its title and collects
 * the optional note. Dismiss on select → cancelled; dismiss on the note keeps
 * the answer (the user already answered the graded part).
 */
async function askSingleChoiceRpc(
	ctx: ToolContext,
	question: string,
	context: string | undefined,
	options: QuizOption[],
	feedbackText: (answers: OptionAnswer[], dontKnow: boolean) => string,
): Promise<QuizResponse | null> {
	const selectOptions = [...options.map(toDisplayLabel), DONT_KNOW_LABEL];
	const answer = await ctx.ui.select(dialogTitle(question, context), selectOptions);
	if (answer === undefined) return null; // cancelled

	let response: QuizResponse;
	if (answer === DONT_KNOW_LABEL) {
		response = { dontKnow: true, answers: [] };
	} else {
		const index = selectOptions.indexOf(answer) + 1; // 1-based over real options
		const option = options[index - 1];
		response = {
			dontKnow: false,
			answers: [{ label: option.label, value: option.value, index }],
		};
	}
	response.note = await askNoteWithFeedback(
		ctx,
		question,
		feedbackText(response.answers, response.dontKnow),
	);
	return response;
}

const MULTI_DELIMITER = ",";
const MULTI_MAX_ATTEMPTS = 3;

interface QuizMultiParseOk {
	ok: true;
	dontKnow: boolean;
	answers: OptionAnswer[];
}
interface QuizMultiParseErr {
	ok: false;
	error: string;
}

/**
 * Parse a free-form multi-select response ("1,3") into answers.
 * The sentinel index (options.length + 1) marks "I don't know" and is
 * exclusive: its presence discards every other pick.
 */
export function parseQuizMultiResponse(raw: string, options: QuizOption[]): QuizMultiParseOk | QuizMultiParseErr {
	const tokens = raw
		.split(MULTI_DELIMITER)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) {
		return { ok: false, error: "empty input" };
	}

	const max = options.length + 1; // +1 for "I don't know"
	const seen = new Set<number>();
	const answers: OptionAnswer[] = [];
	let dontKnow = false;
	for (const token of tokens) {
		if (!/^\d+$/.test(token)) {
			return { ok: false, error: `not a number: "${token}"` };
		}
		const index = parseInt(token, 10);
		if (index < 1 || index > max) {
			return { ok: false, error: `index ${index} out of range (1-${max})` };
		}
		if (seen.has(index)) {
			return { ok: false, error: `duplicate: ${index}` };
		}
		seen.add(index);
		if (index === max) {
			dontKnow = true; // exclusive — other picks are discarded below
		} else {
			const option = options[index - 1];
			answers.push({ label: option.label, value: option.value, index });
		}
	}
	if (dontKnow && answers.length > 0) {
		answers.length = 0; // "I don't know" clears real selections (original semantics)
	}
	return { ok: true, dontKnow, answers };
}

/**
 * Multi-select over a single-pick channel: free-form numeric selection with a
 * bounded re-prompt loop, then one input() that shows the graded feedback in
 * its title and collects the optional note.
 */
async function askMultiChoiceRpc(
	ctx: ToolContext,
	question: string,
	context: string | undefined,
	options: QuizOption[],
	feedbackText: (answers: OptionAnswer[], dontKnow: boolean) => string,
): Promise<QuizResponse | null> {
	const dontKnowIndex = options.length + 1;
	const lines = [
		dialogTitle(question, context),
		"",
		...options.map((option, index) => `${index + 1}. ${toDisplayLabel(option)}`),
		`${dontKnowIndex}. ${DONT_KNOW_LABEL} (exclusive — discards other picks)`,
		"",
		`Reply with number(s) separated by "${MULTI_DELIMITER}" — e.g. 1,${options.length}. "${dontKnowIndex}" alone = ${DONT_KNOW_LABEL}.`,
	];

	for (let attempt = 1; attempt <= MULTI_MAX_ATTEMPTS; attempt++) {
		const raw = await ctx.ui.input(lines.join("\n"), `e.g. 1${MULTI_DELIMITER}2`);
		if (raw === undefined) return null; // cancelled

		const parsed = parseQuizMultiResponse(raw, options);
		if (parsed.ok) {
			const response: QuizResponse = { dontKnow: parsed.dontKnow, answers: parsed.answers };
			response.note = await askNoteWithFeedback(
				ctx,
				question,
				feedbackText(response.answers, response.dontKnow),
			);
			return response;
		}
		if (attempt < MULTI_MAX_ATTEMPTS) {
			ctx.ui.notify(`Invalid selection: ${parsed.error}. Please try again.`, "warning");
		}
	}
	ctx.ui.notify(`No valid selection after ${MULTI_MAX_ATTEMPTS} attempts`, "warning");
	return null;
}

// ---------------------------------------------------------------------------
// Shared UI mutex — same globalThis key as ask-user-question so every popup
// tool serializes against each other, not just against itself.
// ---------------------------------------------------------------------------

const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
interface SharedUiLock {
	withLock<T>(fn: () => T | Promise<T>): Promise<T>;
}
function getSharedUiLock(): SharedUiLock {
	const g = globalThis as Record<string, unknown>;
	const existing = g[SHARED_UI_LOCK_KEY] as SharedUiLock | undefined;
	if (existing) return existing;

	let chain: Promise<void> = Promise.resolve();
	const lock: SharedUiLock = {
		withLock<T>(fn: () => T | Promise<T>): Promise<T> {
			const prev = chain;
			let release: () => void;
			chain = new Promise<void>((resolve) => {
				release = resolve;
			});
			return prev.then(fn).finally(() => release!());
		},
	};
	g[SHARED_UI_LOCK_KEY] = lock;
	return lock;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function quiz(pi: ExtensionAPI) {
	// Smoke-verification hook: pi 0.84 RPC has no tool-listing command, so a
	// registered slash command stands in as proof the extension loaded.
	pi.registerCommand("quiz-dev", {
		description: "Verify quiz extension is loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify("quiz extension active", "info");
		},
	});

	pi.registerTool({
		name: "quiz",
		label: "quiz",
		description:
			"Pose a single multiple-choice question that HAS a correct answer, grade the user's selection instantly, and show feedback (✓/✗, the correct answer, an explanation) to both the user and the agent. Options only — no free-text mode. Use for checking understanding during teaching/learning sessions.",
		promptSnippet: "Use this tool to quiz the user with exactly one graded multiple-choice question at a time.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"Give every option a stable `value` and reference the correct one by that value in correctAnswer — never by position.",
			"Always provide an explanation; it is revealed after the user answers, regardless of correctness.",
			'The user can always answer "I don\'t know" — treat it as a knowledge gap, not a wrong guess.',
			"multiSelect is true only when several options are correct and the user must pick exactly that set.",
			"Leave shuffle on (default) unless option order is meaningful.",
		],
		parameters: QuizParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const ui = ctx as ToolContext;
			const context = params.details?.trim() || undefined;
			const explanation = params.explanation.trim();
			const mode: QuizMode = params.multiSelect ? "multi-select" : "single-select";

			let options: QuizOption[];
			try {
				options = normalizeOptions(params.options);
			} catch (e) {
				return unavailableResult(params.question, mode, `quiz ${(e as Error).message}`, [], context);
			}

			// Shuffle for display (default on) BEFORE resolving correct indices, so
			// grading matches the order the user sees.
			if (params.shuffle !== false) {
				options = shuffleOptions(options);
			}

			// Emit the true (post-shuffle) display order before the UI blocks.
			// Listeners such as md-log rely on this; must not leak the answer.
			onUpdate?.({
				content: [{ type: "text", text: "Awaiting user response..." }],
				details: { options: options.map((o, i) => ({ index: i + 1, label: o.label })) },
			});

			const { indices: correctIndices, error: correctError } = resolveCorrect(
				params.correctAnswer as string | string[],
				options,
			);

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, correctIndices, context);
			}

			if (options.length < 2) {
				return unavailableResult(params.question, mode, "quiz requires at least two options", correctIndices, context);
			}

			if (correctError) {
				return unavailableResult(params.question, mode, `quiz ${correctError}`, correctIndices, context);
			}

			if (!ui.hasUI) {
				return unavailableResult(params.question, mode, "quiz requires interactive mode UI", correctIndices, context);
			}

			return getSharedUiLock().withLock(async () => {
				// Feedback is computed from the graded answer (never the note) and
				// delivered inside the note dialog title — the only user-visible
				// channel that survives pi→Paseo RPC mid-turn.
				const feedback = (answers: OptionAnswer[], dontKnow: boolean) =>
					buildFeedbackText(
						options,
						answers.map((a) => a.index),
						correctIndices,
						explanation,
						dontKnow,
					);
				const response =
					mode === "single-select"
						? await askSingleChoiceRpc(ui, params.question, context, options, feedback)
						: await askMultiChoiceRpc(ui, params.question, context, options, feedback);
				if (!response) {
					return cancelledResult(params.question, mode, correctIndices, context);
				}
				return buildResult(params.question, context, mode, options, response, correctIndices, explanation);
			});
		},

		renderCall(args, theme: Theme) {
			// Never render correctAnswer or explanation here — it would leak the
			// answer into the transcript before the user responds.
			const options = normalizeOptions(
				args.options as Array<{ label: string; value?: string; description?: string }> | undefined,
			);
			let text = theme.fg("toolTitle", theme.bold("quiz ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const noun = options.length === 1 ? "option" : "options";
				text += theme.fg("dim", ` (${options.length} ${noun})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme: Theme) {
			const details = result.details as QuizResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "quiz unavailable"), 0, 0);
			}

			const correctSet = new Set(details.correctIndices);
			const selectedSet = new Set(details.answers.map((a) => a.index));
			const lines: string[] = [];

			const displayed =
				details.options && details.options.length > 0
					? details.options
					: details.answers.map((a) => ({ index: a.index, label: a.label }));

			for (const opt of displayed) {
				const isSelected = selectedSet.has(opt.index);
				const isKey = correctSet.has(opt.index);
				let mark: string;
				let body: string;
				if (details.dontKnow) {
					mark = isKey ? theme.fg("success", "✓ ") : "  ";
					body = isKey
						? theme.fg("success", `${opt.index}. ${opt.label}`)
						: theme.fg("dim", `${opt.index}. ${opt.label}`);
				} else if (isSelected && isKey) {
					mark = theme.fg("success", "✓ ");
					body = theme.fg("accent", `${opt.index}. ${opt.label}`);
				} else if (isSelected && !isKey) {
					mark = theme.fg("error", "✗ ");
					body = theme.fg("error", `${opt.index}. ${opt.label}`);
				} else if (!selectedSet.has(opt.index) && isKey) {
					mark = theme.fg("success", "✓ ");
					body = theme.fg("success", `${opt.index}. ${opt.label}`);
				} else {
					mark = "  ";
					body = theme.fg("dim", `${opt.index}. ${opt.label}`);
				}
				lines.push(`${mark}${body}`);
			}

			lines.push("");
			const verdict = details.dontKnow
				? theme.fg("warning", "I don't know")
				: details.correct
					? theme.fg("success", "Correct!")
					: theme.fg("error", "Incorrect");
			lines.push(verdict);

			if (details.note) {
				lines.push(theme.fg("muted", `Note: ${details.note}`));
			}
			if (details.explanation) {
				lines.push(theme.fg("muted", details.explanation));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
