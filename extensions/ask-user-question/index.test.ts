import { describe, expect, test } from "bun:test";
import { toDisplayLabel, parseMultiSelectResponse } from "./index";

const options = [
	{ label: "JWT", value: "jwt", description: "stateless tokens" },
	{ label: "Session cookies", value: "session" },
	{ label: "OAuth2", value: "oauth", description: "delegated auth" },
];

describe("toDisplayLabel", () => {
	test("embeds description with em-dash", () => {
		expect(toDisplayLabel(options[0])).toBe("JWT — stateless tokens");
	});
	test("bare label when no description", () => {
		expect(toDisplayLabel(options[1])).toBe("Session cookies");
	});
});

describe("parseMultiSelectResponse", () => {
	test("single valid index", () => {
		const r = parseMultiSelectResponse("1", options);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.answers).toHaveLength(1);
			expect(r.answers[0]).toMatchObject({ type: "option", label: "JWT", value: "jwt", index: 1 });
		}
	});

	test("multiple indices unordered with spaces", () => {
		const r = parseMultiSelectResponse(" 3, 1 ", options);
		expect(r.ok).toBe(true);
		if (r.ok) {
			// parser preserves user order; sorting happens in askMultiChoiceRpc
			expect(r.answers.map((a) => (a.type === "option" ? a.index : -1))).toEqual([3, 1]);
		}
	});
	test("other sentinel is options.length + 1", () => {
		const r = parseMultiSelectResponse("2,4", options);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.answers[0]).toMatchObject({ type: "option", index: 2 });
			expect(r.answers[1]).toMatchObject({ type: "other", label: "" });
		}
	});

	test("empty input rejected", () => {
		expect(parseMultiSelectResponse("   ", options)).toMatchObject({ ok: false });
		expect(parseMultiSelectResponse(",", options)).toMatchObject({ ok: false });
	});

	test("non-numeric token rejected", () => {
		expect(parseMultiSelectResponse("1,a", options)).toMatchObject({ ok: false });
	});

	test("out of range rejected (0 and max+1)", () => {
		expect(parseMultiSelectResponse("0", options)).toMatchObject({ ok: false });
		expect(parseMultiSelectResponse("5", options)).toMatchObject({ ok: false });
	});

	test("duplicate rejected", () => {
		expect(parseMultiSelectResponse("2,2", options)).toMatchObject({ ok: false });
	});

	test("range syntax not supported — rejected as non-numeric", () => {
		expect(parseMultiSelectResponse("1-3", options)).toMatchObject({ ok: false });
	});
});
