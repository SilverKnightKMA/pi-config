import { describe, expect, test } from "bun:test";
import {
	ARCHIVE_REMIND_REARM_MS,
	MIN_IDLE_CHILDREN,
	readArchiveRemindMinutes,
	shouldRemindIdleArchive,
	toIdleChildren,
	type IdleChild,
} from "./idle-archive.ts";
import { parseAgentList } from "./paseo-channel.ts";

const NOW = Date.parse("2026-09-20T13:00:00.000Z");
const OLD = "2026-09-20T11:00:00.000Z"; // 2h before NOW
const FRESH = "2026-09-20T12:55:00.000Z"; // 5 min before NOW

function child(over: Partial<IdleChild> = {}): IdleChild {
	return { id: over.id ?? "a1", status: "idle", lastActivityMs: Date.parse(OLD), attentionMs: null, ...over };
}

describe("shouldRemindIdleArchive", () => {
	test("3 children all idle ≥2h → remind with paste-ready command", () => {
		const r = shouldRemindIdleArchive(
			[child({ id: "c1" }), child({ id: "c2" }), child({ id: "c3" })],
			NOW,
			15,
		);
		expect(r).not.toBeNull();
		if (r) expect(r.command).toBe("paseo agent archive c1 c2 c3");
	});
	test("newest child only 5m idle → still inside the 15m grace → null", () => {
		const r = shouldRemindIdleArchive(
			[child({ id: "c1" }), child({ id: "c2" }), child({ id: "c3", lastActivityMs: Date.parse(FRESH) })],
			NOW,
			15,
		);
		expect(r).toBeNull();
	});
	test("any running/initializing/waiting child → null (not all quiescent)", () => {
		for (const status of ["running", "initializing", "waiting"]) {
			expect(shouldRemindIdleArchive([child({ id: "c1" }), child({ id: "c2" }), child({ id: "c3", status })], NOW, 15)).toBeNull();
		}
	});
	test("parked child (attention marker) → null — never nudge an open question", () => {
		const r = shouldRemindIdleArchive(
			[child({ id: "c1" }), child({ id: "c2" }), child({ id: "c3", attentionMs: Date.parse(OLD) })],
			NOW,
			15,
		);
		expect(r).toBeNull();
	});
	test("unknown last activity → fail-closed null", () => {
		expect(shouldRemindIdleArchive([child({ id: "c1" }), child({ id: "c2" }), child({ id: "c3", lastActivityMs: null })], NOW, 15)).toBeNull();
	});
	test("fewer than MIN_IDLE_CHILDREN → null; minutes=0 → disabled null", () => {
		expect(shouldRemindIdleArchive([child(), child()], NOW, 15)).toBeNull();
		expect(MIN_IDLE_CHILDREN).toBe(3);
		const three = [child({ id: "c1" }), child({ id: "c2" }), child({ id: "c3" })];
		expect(shouldRemindIdleArchive(three, NOW, 0)).toBeNull();
		expect(shouldRemindIdleArchive(three, NOW, 15)).not.toBeNull();
	});
	test("re-arm window constant is 60 minutes", () => {
		expect(ARCHIVE_REMIND_REARM_MS).toBe(60 * 60_000);
	});
});

describe("toIdleChildren", () => {
	const wire = {
		agents: [
			{ id: "mine-1", status: "idle", labels: { "subagent.parent": "P1" }, lastActivityAt: OLD },
			{ id: "mine-2", status: "idle", labels: { "paseo.parent-agent-id": "P1" }, updatedAt: OLD },
			{ id: "other-1", status: "idle", labels: { "subagent.parent": "P2" }, lastActivityAt: OLD },
			{ id: "no-label", status: "idle", labels: null },
		],
	};
	test("keeps only my children, accepts both parent labels, parses timestamps", () => {
		const out = toIdleChildren(parseAgentList(wire), "P1");
		expect(out.map((c) => c.id).sort()).toEqual(["mine-1", "mine-2"]);
		expect(out.every((c) => c.lastActivityMs === Date.parse(OLD))).toBe(true);
	});
	test("null parent → empty; unknown timestamps stay null (fail-closed upstream)", () => {
		expect(toIdleChildren(parseAgentList(wire), null)).toEqual([]);
		const bare = parseAgentList({ agents: [{ id: "x", status: "idle", labels: { "subagent.parent": "P1" } }] });
		expect(bare[0].lastActivityAt ?? bare[0].updatedAt).toBeNull();
		expect(toIdleChildren(bare, "P1")[0].lastActivityMs).toBeNull();
	});
	test("attentionTimestamp rides through parseAgentList", () => {
		const out = parseAgentList({ agents: [{ id: "p", status: "idle", labels: { "subagent.parent": "P1" }, attentionTimestamp: OLD }] });
		expect(toIdleChildren(out, "P1")[0].attentionMs).toBe(Date.parse(OLD));
	});
});

describe("readArchiveRemindMinutes", () => {
	test("default 15; workspace wins; 0 disables; clamped to [0,1440]", () => {
		expect(readArchiveRemindMinutes(null, null)).toBe(15);
		expect(readArchiveRemindMinutes({ subagentTypes: { archiveRemindMinutes: 30 } }, { subagentTypes: { archiveRemindMinutes: 0 } })).toBe(30);
		expect(readArchiveRemindMinutes(null, { subagentTypes: { archiveRemindMinutes: 0 } })).toBe(0);
		expect(readArchiveRemindMinutes({ subagentTypes: { archiveRemindMinutes: 99999 } }, null)).toBe(1440);
		expect(readArchiveRemindMinutes({ subagentTypes: {} }, null)).toBe(15);
		expect(readArchiveRemindMinutes({ subagentTypes: { archiveRemindMinutes: "20" } }, null)).toBe(15); // non-number ignored
	});
});
