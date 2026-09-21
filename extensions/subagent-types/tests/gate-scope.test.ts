import { describe, expect, test } from "bun:test";
import { hasChildEnvCarrier, roleGateApplies } from "../gate-scope.ts";

const CLEAN = { PATH: "/usr/bin", HOME: "/tmp" };

describe("gate-scope #188 — human CLI session keeps full tools", () => {
	test("record found (myAgentId) → gate applies, even with clean env", () => {
		// labeled child AND unlabelled-record anti-spoof case both resolve via record
		expect(roleGateApplies("a1", CLEAN)).toBe(true);
	});

	test("no record + clean env → human CLI session → gate INACTIVE (the #188 fix)", () => {
		// This is the live repro: plain `pi` from the terminal — task_list was denied
		expect(roleGateApplies(null, CLEAN)).toBe(false);
	});

	test("no record + PASEO_PARENT_AGENT_ID carrier → gate applies (pre-record race)", () => {
		expect(roleGateApplies(null, { ...CLEAN, PASEO_PARENT_AGENT_ID: "parent-1" })).toBe(true);
	});

	test("no record + PASEO_SUBAGENTS_DOOR carrier → gate applies (door child / env-first main)", () => {
		expect(roleGateApplies(null, { ...CLEAN, PASEO_SUBAGENTS_DOOR: "http://127.0.0.1:9/mcp" })).toBe(true);
	});

	test("hasChildEnvCarrier: either marker counts; empty-string markers do not", () => {
		expect(hasChildEnvCarrier(CLEAN)).toBe(false);
		expect(hasChildEnvCarrier({ PASEO_PARENT_AGENT_ID: "p" })).toBe(true);
		expect(hasChildEnvCarrier({ PASEO_SUBAGENTS_DOOR: "http://x" })).toBe(true);
		expect(hasChildEnvCarrier({ PASEO_PARENT_AGENT_ID: "", PASEO_SUBAGENTS_DOOR: "" })).toBe(false);
	});
});
