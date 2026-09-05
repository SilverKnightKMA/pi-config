import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { controlFilePath, parseControlPayload,
	parseTwoGroupSelection,
	askGroupSelection,
	parseSnippet,
	loadSnippets,
	applySnippets,
	parseSelection,
	snippetLine,
} from "./index";

describe("parseSnippet", () => {
	test("parses frontmatter + body", () => {
		const raw = `---
name: Test snippet
description: does things
placement: prepend
order: 5
---
Body line one.
Body line two.`;
		const s = parseSnippet("test.md", raw);
		expect(s).not.toBeNull();
		expect(s!.name).toBe("Test snippet");
		expect(s!.placement).toBe("prepend");
		expect(s!.order).toBe(5);
		expect(s!.body).toContain("Body line one.");
	});

	test("defaults: append placement, order 9999, name from filename", () => {
		const s = parseSnippet("minimal.md", "---\n\n---\n\nsome body");
		expect(s!.placement).toBe("append");
		expect(s!.order).toBe(9999);
		expect(s!.name).toBe("minimal");
	});

	test("null when body empty", () => {
		expect(parseSnippet("empty.md", "---\nname: x\n---\n")).toBeNull();
	});
});

describe("loadSnippets", () => {
	test("loads the 6 ported snippets, prepend group first", () => {
		const snippets = loadSnippets();
		expect(snippets.length).toBe(6);
		const firstPrepend = snippets.findIndex((s) => s.placement === "prepend");
		const firstAppend = snippets.findIndex((s) => s.placement === "append");
		expect(firstPrepend).toBeLessThan(firstAppend);
	});

	test("ordering follows order field within groups", () => {
		const snippets = loadSnippets();
		const kickoff = snippets.find((s) => s.name.includes("kickoff"))!;
		const prependGroup = snippets.filter((s) => s.placement === "prepend");
		expect(prependGroup[0].id).toBe(kickoff.id); // order 10 → first
	});
});

describe("applySnippets", () => {
	const snippets = loadSnippets();

	test("no active ids → text unchanged", () => {
		expect(applySnippets(snippets, [], "hello")).toBe("hello");
	});

	test("prepend wraps before, append after", () => {
		const prep = snippets.find((s) => s.placement === "prepend")!;
		const app = snippets.find((s) => s.placement === "append")!;
		const out = applySnippets(snippets, [prep.id, app.id], "HELLO");
		const parts = out.split("\n\n");
		expect(parts.length).toBe(3);
		expect(parts[0]).toContain(prep.body.slice(0, 20));
		expect(parts[1]).toBe("HELLO");
		expect(parts[2]).toContain(app.body.slice(0, 20));
	});

	test("appends render in canonical (order, name) sort regardless of selection order", () => {
		const appendGroup = snippets.filter((s) => s.placement === "append");
		expect(appendGroup.length).toBeGreaterThanOrEqual(2);
		const idsReversed = [...appendGroup].reverse().map((s) => s.id);
		const out = applySnippets(snippets, idsReversed, "X");
		const parts = out.split("\n\n");
		// no prepend selected → parts[0] is the user text; appends follow in
		// the canonical order of the display list (ask → verify → delegate → diagnose)
		expect(parts[0]).toBe("X");
		expect(parts[1].startsWith(appendGroup[0].body.slice(0, 15))).toBe(true);
		expect(parts[2].startsWith(appendGroup[1].body.slice(0, 15))).toBe(true);
	});
});

describe("parseSelection", () => {
	const snippets = loadSnippets();

	test("single index", () => {
		const r = parseSelection("1", snippets);
		expect(r.error).toBeUndefined();
		expect(r.ids).toEqual([snippets[0].id]);
	});

	test("multi with spaces, dedupes", () => {
		const r = parseSelection(" 2, 1,1 ", snippets);
		expect(r.ids).toEqual([snippets[1].id, snippets[0].id]);
	});

	test("blank or 0 → none", () => {
		expect(parseSelection("", snippets).ids).toEqual([]);
		expect(parseSelection("0", snippets).ids).toEqual([]);
	});

	test("out of range and non-numeric rejected", () => {
		expect(parseSelection("7", snippets).error).toContain("out of range");
		expect(parseSelection("x", snippets).error).toContain("not a number");
	});
});

describe("snippetLine", () => {
	test("embeds placement tag and description", () => {
		const s = { id: "a.md", name: "Alpha", description: "first snippet", placement: "prepend" as const, order: 1, body: "b" };
		const line = snippetLine(s, 2);
		expect(line).toBe("2. ↑ Alpha — first snippet");
	});

	test("no description → no dash suffix", () => {
		const s = { id: "b.md", name: "Beta", description: "", placement: "append" as const, order: 2, body: "b" };
		expect(snippetLine(s, 1)).toBe("1. ↓ Beta");
	});
});


describe("parseTwoGroupSelection (combined 2-dialog answer)", () => {
	const all = loadSnippets();
	const prepends = all.filter((s) => s.placement === "prepend");
	const appends = all.filter((s) => s.placement === "append");

	test("both groups selected", () => {
		const ids = parseTwoGroupSelection("1 | 1", prepends, appends);
		expect(ids).toEqual([prepends[0].id, appends[0].id]);
	});

	test("append only", () => {
		const ids = parseTwoGroupSelection(" | 2,3", prepends, appends);
		expect(ids).toEqual([appends[1].id, appends[2].id]);
	});

	test("prepend only (no pipe)", () => {
		const ids = parseTwoGroupSelection("2", prepends, appends);
		expect(ids).toEqual([prepends[1].id]);
	});

	test("empty answer → none", () => {
		expect(parseTwoGroupSelection("", prepends, appends)).toEqual([]);
		expect(parseTwoGroupSelection("   ", prepends, appends)).toEqual([]);
	});

	test("out-of-range and junk tokens skipped", () => {
		const ids = parseTwoGroupSelection("99,x | 0,y,1", prepends, appends);
		expect(ids).toEqual([appends[0].id]);
	});

	test("duplicates collapse", () => {
		const ids = parseTwoGroupSelection("1,1 | 1,1", prepends, appends);
		expect(ids).toEqual([prepends[0].id, appends[0].id]);
	});
});

describe("askGroupSelection (3-step guided flow)", () => {
	const makeCtx = (inputs: (string | undefined)[]) => {
		let i = 0;
		const dialogs: { title: string }[] = [];
		return {
			dialogs,
			ui: {
				input: async (title: string) => { dialogs.push({ title }); return inputs[i++]; },
				notify: () => {},
			},
		};
	};
	const prepends = loadSnippets().filter((s) => s.placement === "prepend");

	test("numeric answer selects from the group only", async () => {
		const ctx = makeCtx(["1"]);
		const r = await askGroupSelection(ctx as never, "2/3", "PREPEND — test", prepends);
		expect(r.cancelled).toBe(false);
		expect(r.ids).toEqual([prepends[0].id]);
		expect(ctx.dialogs[0].title).toContain("step 2/3");
		expect(ctx.dialogs[0].title).toContain("PREPEND");
	});

	test("empty answer = none from group, not cancelled", async () => {
		const r = await askGroupSelection(makeCtx([""]) as never, "2/3", "PREPEND — test", prepends);
		expect(r.cancelled).toBe(false);
		expect(r.ids).toEqual([]);
	});

	test("dismiss (undefined) cancels the whole flow", async () => {
		const r = await askGroupSelection(makeCtx([undefined]) as never, "2/3", "PREPEND — test", prepends);
		expect(r.cancelled).toBe(true);
	});

	test("invalid answer skips the group with a warning, not a crash", async () => {
		const r = await askGroupSelection(makeCtx(["abc"]) as never, "2/3", "PREPEND — test", prepends);
		expect(r.cancelled).toBe(false);
		expect(r.ids).toEqual([]);
	});

	test("empty group short-circuits without a dialog", async () => {
		const ctx = makeCtx([]);
		const r = await askGroupSelection(ctx as never, "3/3", "APPEND — test", []);
		expect(r.cancelled).toBe(false);
		expect(r.ids).toEqual([]);
		expect(ctx.dialogs).toHaveLength(0);
	});
});

describe("control file bridge (v1.5 plugin <-> engine)", () => {
	test("parseControlPayload: valid request keeps ids + sentAt", () => {
		const p = parseControlPayload(`{"v":1,"active":["a.md","b.md"],"sticky":true,"sentAt":"2026-09-05T00:00:00Z"}`);
		expect(p).not.toBeNull();
		expect(p!.active).toEqual(["a.md", "b.md"]);
		expect(p!.sticky).toBe(true);
		expect(p!.sentAt).toBe("2026-09-05T00:00:00Z");
		expect(p!.ackAt).toBeUndefined();
	});

	test("parseControlPayload: rejects malformed JSON, wrong version, non-array active", () => {
		expect(parseControlPayload("not json")).toBeNull();
		expect(parseControlPayload(`{"v":2,"active":[],"sticky":false}`)).toBeNull();
		expect(parseControlPayload(`{"v":1,"active":"x","sticky":false}`)).toBeNull();
		expect(parseControlPayload(`{"v":1,"active":[],"sticky":"yes"}`)).toBeNull();
	});

	test("parseControlPayload: non-string ids are filtered out", () => {
		const p = parseControlPayload(`{"v":1,"active":["ok.md",42,null],"sticky":false}`);
		expect(p!.active).toEqual(["ok.md"]);
	});

	test("parseControlPayload: ack echo round-trips", () => {
		const p = parseControlPayload(`{"v":1,"active":[],"sticky":false,"sentAt":"t1","ackAt":"t2"}`);
		expect(p!.sentAt).toBe("t1");
		expect(p!.ackAt).toBe("t2");
	});

	test("controlFilePath: one per session under snip-control/", () => {
		const p = controlFilePath("abc123");
		expect(p.endsWith(join(".pi", "agent", "snip-control", "abc123.json"))).toBe(true);
	});
});
