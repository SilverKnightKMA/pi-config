import { describe, expect, test } from "bun:test";
import {
	shuffleOptions,
	coerceCorrectAnswer,
	resolveCorrect,
	isCorrect,
	parseQuizMultiResponse,
	toDisplayLabel,
} from "./index";

const options = [
	{ label: "Mercury", value: "mercury", description: "smallest planet" },
	{ label: "Venus", value: "venus" },
	{ label: "Earth", value: "earth" },
];

describe("shuffleOptions", () => {
	test("preserves all values regardless of order", () => {
		for (let i = 0; i < 20; i++) {
			const shuffled = shuffleOptions(options);
			expect(shuffled.map((o) => o.value).sort()).toEqual(["earth", "mercury", "venus"]);
		}
	});
	test("does not mutate input", () => {
		const original = [...options];
		shuffleOptions(options);
		expect(options).toEqual(original);
	});
});

describe("coerceCorrectAnswer", () => {
	test("single string stays single", () => {
		expect(coerceCorrectAnswer("mercury")).toEqual(["mercury"]);
	});
	test("real array passes through", () => {
		expect(coerceCorrectAnswer(["a", "b"])).toEqual(["a", "b"]);
	});
	test("JSON-stringified array is parsed back", () => {
		expect(coerceCorrectAnswer('["a", "b"]')).toEqual(["a", "b"]);
	});
	test("bracketed non-JSON stays literal", () => {
		expect(coerceCorrectAnswer("[not json")).toEqual(["[not json"]);
	});
});

describe("resolveCorrect", () => {
	test("resolves by value to shuffled position", () => {
		const shuffled = [options[2], options[0], options[1]]; // earth, mercury, venus
		const r = resolveCorrect("mercury", shuffled);
		expect(r.indices).toEqual([2]);
		expect(r.error).toBeUndefined();
	});
	test("unknown value errors with known values listed", () => {
		const r = resolveCorrect("mars", options);
		expect(r.error).toContain("mars");
		expect(r.error).toContain("mercury");
	});
	test("undefined correctAnswer errors", () => {
		expect(resolveCorrect(undefined, options).error).toBe("correctAnswer is required");
	});
	test("multi answer resolves to sorted indices", () => {
		const r = resolveCorrect(["venus", "mercury"], options);
		expect(r.indices).toEqual([1, 2]);
	});
});

describe("isCorrect", () => {
	test("exact set match regardless of order", () => {
		expect(isCorrect([3, 1], [1, 3])).toBe(true);
	});
	test("wrong length fails", () => {
		expect(isCorrect([1], [1, 2])).toBe(false);
	});
	test("different set fails", () => {
		expect(isCorrect([1, 2], [1, 3])).toBe(false);
	});
});

describe("toDisplayLabel", () => {
	test("embeds description", () => {
		expect(toDisplayLabel(options[0])).toBe("Mercury — smallest planet");
	});
	test("bare label without description", () => {
		expect(toDisplayLabel(options[1])).toBe("Venus");
	});
});

describe("parseQuizMultiResponse", () => {
	test("single valid index", () => {
		const r = parseQuizMultiResponse("2", options);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dontKnow).toBe(false);
			expect(r.answers[0]).toMatchObject({ label: "Venus", value: "venus", index: 2 });
		}
	});

	test("multiple unordered with spaces", () => {
		const r = parseQuizMultiResponse(" 3, 1 ", options);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.answers.map((a) => a.index)).toEqual([3, 1]);
		}
	});

	test("dont-know sentinel is last index and exclusive", () => {
		const r = parseQuizMultiResponse("1,4", options); // 4 = options.length + 1
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dontKnow).toBe(true);
			expect(r.answers).toEqual([]); // other picks discarded
		}
	});

	test("dont-know alone works", () => {
		const r = parseQuizMultiResponse("4", options);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dontKnow).toBe(true);
			expect(r.answers).toEqual([]);
		}
	});

	test("invalid: empty / non-numeric / range / duplicate", () => {
		expect(parseQuizMultiResponse("  ", options)).toMatchObject({ ok: false });
		expect(parseQuizMultiResponse("1,x", options)).toMatchObject({ ok: false });
		expect(parseQuizMultiResponse("0", options)).toMatchObject({ ok: false });
		expect(parseQuizMultiResponse("5", options)).toMatchObject({ ok: false });
		expect(parseQuizMultiResponse("2,2", options)).toMatchObject({ ok: false });
	});
});
