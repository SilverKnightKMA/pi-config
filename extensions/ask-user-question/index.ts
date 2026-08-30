/**
 * ask_user_question — RPC-compatible fork of amosblomqvist/pi-config extension.
 *
 * Same tool contract, same result semantics (answered / cancelled / unavailable),
 * but the UI layer only uses RPC-safe methods:
 *   - select(title, options)     single-select
 *   - input(title, placeholder)  free-form text + "Other" follow-up + multi-select
 *   - editor(title, prefill)     multi-line text mode
 * `ctx.ui.custom()` (TUI-only, resolves undefined in RPC mode) is never called.
 *
 * Deliberate differences from the original:
 *   1. Option descriptions are embedded into the option label ("label — desc")
 *      because pi RPC select() only carries string labels.
 *   2. multiSelect is collected as free-form numeric selection ("1,3") over an
 *      input() dialog — pi RPC has no multi-select channel. Parsed and validated
 *      in-extension; invalid input re-prompts (bounded).
 *   3. "Other" is a two-step flow: select returns OTHER_LABEL, then input()
 *      collects the custom text. Model-visible result is unchanged.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskOption {
	label: string;
	value?: string;
	description?: string;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
}

/** Minimal structural view of the extension ctx we rely on. */
interface ToolContext {
	hasUI: boolean;
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		editor: (title: string, prefill?: string) => Promise<string | undefined>;
		notify: (message: string, type?: "info" | "warning" | "error") => void;
	};
}


const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "Optional extra detail shown below the option." }),
	),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

function normalizeOptions(
	options: Array<{ label: string; value?: string; description?: string }> | undefined,
): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other")
		? "Other (custom)"
		: "Other";
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		default:
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
): AskUserQuestionResultDetails {
	return { status, question, context, mode, answers, message };
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function buildResult(
	question: string,
	context: string | undefined,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text =
			answer.label.trim().length > 0
				? `User answered: ${answer.label}`
				: "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

// ---------------------------------------------------------------------------
// RPC-safe UI layer
// ---------------------------------------------------------------------------

/** Collapse label + description into one string: "label — description". */
export function toDisplayLabel(option: AskOption): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

/** Map a display label returned by select() back to its option. */
function fromDisplayLabel(display: string, options: AskOption[]): AskOption {
	const match = options.find((option) => toDisplayLabel(option) === display);
	if (match) return match;
	// Fallback: bare-label match (host may have altered the combined string).
	return options.find((option) => option.label === display) ?? { label: display, value: display };
}

/** Compose dialog title from question + context. */
function dialogTitle(question: string, context: string | undefined): string {
	return context ? `${question}\n\n${context}` : question;
}

/**
 * Single-select via one select() call. "Other" expands into a follow-up input().
 * Dismiss/cancel at any step resolves to null (cancelled).
 */
async function askSingleChoiceRpc(
	ctx: ToolContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer | null> {
	const otherLabel = getOtherLabel(options);
	const selectOptions = [...options.map(toDisplayLabel), otherLabel];

	const answer = await ctx.ui.select(dialogTitle(question, context), selectOptions);
	if (answer === undefined) return null;

	if (answer === otherLabel) {
		const custom = await ctx.ui.input(`${question} — custom answer`, "Type your answer…");
		if (custom === undefined || custom.trim().length === 0) return null;
		return { type: "other", label: custom.trim(), value: custom.trim() };
	}

	const option = fromDisplayLabel(answer, options);
	return {
		type: "option",
		label: option.label,
		value: option.value ?? option.label,
		index: options.indexOf(option) + 1,
	};
}

const MULTI_DELIMITER = ",";
const MULTI_MAX_ATTEMPTS = 3;

interface MultiParseOk {
	ok: true;
	answers: AskAnswer[];
}
interface MultiParseErr {
	ok: false;
	error: string;
}

/**
 * Parse a free-form multi-select response ("1,3") into answers.
 * The sentinel index (options.length + 1) marks "Other"; its label is filled
 * in by the caller after collecting the custom text.
 */
export function parseMultiSelectResponse(
	raw: string,
	options: AskOption[],
): MultiParseOk | MultiParseErr {
	const tokens = raw
		.split(MULTI_DELIMITER)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) {
		return { ok: false, error: "empty input" };
	}

	const max = options.length + 1; // +1 for Other
	const seen = new Set<number>();
	const answers: AskAnswer[] = [];
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
			answers.push({ type: "other", label: "", value: "" });
		} else {
			const option = options[index - 1];
			answers.push({ type: "option", label: option.label, value: option.value ?? option.label, index });
		}
	}
	return { ok: true, answers };
}

/**
 * Multi-select over a single-pick channel: free-form numeric selection.
 * The dialog lists numbered options; the user replies with indices ("1,3").
 * Selecting the Other sentinel triggers a follow-up input() for custom text.
 * Invalid input re-prompts up to MULTI_MAX_ATTEMPTS, then cancels.
 */
async function askMultiChoiceRpc(
	ctx: ToolContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer[] | null> {
	const otherLabel = getOtherLabel(options);
	const lines = [
		dialogTitle(question, context),
		"",
		...options.map((option, index) => `${index + 1}. ${toDisplayLabel(option)}`),
		`${options.length + 1}. ${otherLabel} (type your own)`,
		"",
		`Reply with number(s) separated by "${MULTI_DELIMITER}" — e.g. 1,${options.length + 1} picks the first option plus ${otherLabel}.`,
	];

	for (let attempt = 1; attempt <= MULTI_MAX_ATTEMPTS; attempt++) {
		const raw = await ctx.ui.input(lines.join("\n"), `e.g. 1${MULTI_DELIMITER}2`);
		if (raw === undefined) return null; // cancelled

		const parsed = parseMultiSelectResponse(raw, options);
		if (parsed.ok) {
			const answers: AskAnswer[] = [];
			for (const answer of parsed.answers) {
				if (answer.type === "other") {
					const custom = await ctx.ui.input(`${question} — custom answer`, "Type your answer…");
					if (custom === undefined || custom.trim().length === 0) continue; // skip empty Other
					answers.push({ type: "other", label: custom.trim(), value: custom.trim() });
				} else {
					answers.push(answer);
				}
			}
			return answers.length > 0 ? sortAnswers(answers) : null;
		}
		if (attempt < MULTI_MAX_ATTEMPTS) {
			ctx.ui.notify(`Invalid selection: ${parsed.error}. Please try again.`, "warning");
		}
	}
	ctx.ui.notify(`No valid selection after ${MULTI_MAX_ATTEMPTS} attempts`, "warning");
	return null;
}

// ---------------------------------------------------------------------------
// Shared UI mutex (same pattern as the original: stash on globalThis so
// separate extension files serialize popups without importing each other)
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

export default function askUserQuestion(pi: ExtensionAPI) {
	// Smoke-verification hook: pi 0.84 RPC has no tool-listing command, so a
	// registered slash command stands in as proof the extension loaded.
	pi.registerCommand("ask-user-question-dev", {
		description: "Verify ask_user_question extension is loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify("ask_user_question extension active", "info");
		},
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question. Multi-select answers are collected as free-form numeric selection (e.g. \"1,3\") and are parsed and validated by the extension.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const ui = ctx as ToolContext;
			const options = normalizeOptions(params.options);
			const context = params.details?.trim() || undefined;
			const mode: AskUserQuestionMode =
				options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}

			if (!ui.hasUI) {
				return unavailableResult(
					params.question,
					mode,
					"ask_user_question requires interactive mode UI",
					context,
				);
			}

			return getSharedUiLock().withLock(async () => {
				if (mode === "text") {
					const answer = await ui.ui.editor(dialogTitle(params.question, context));
					if (answer === undefined) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [
						{ type: "text", label: answer.trim(), value: answer.trim() },
					]);
				}

				if (mode === "single-select") {
					const answer = await askSingleChoiceRpc(ui, params.question, context, options);
					if (!answer) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [answer]);
				}

				const answers = await askMultiChoiceRpc(ui, params.question, context, options);
				if (!answers) {
					return cancelledResult(params.question, mode, context);
				}
				return buildResult(params.question, context, mode, answers);
			});
		},

		renderCall(args, theme: Theme) {
			const options = normalizeOptions(
				args.options as Array<{ label: string; value?: string; description?: string }> | undefined,
			);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const labels = [...options.map(toDisplayLabel), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme: Theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(
					theme.fg("warning", details.message || "ask_user_question unavailable"),
					0,
					0,
				);
			}

			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
