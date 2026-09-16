import { describe, expect, test } from "bun:test";
import { LoopGuard, loopGuardConfigFromEnv } from "./loop-guard.ts";

describe("LoopGuard (port @pify/swarm 0.8.0, task #60)", () => {
	test("3 identical tool-free turns → stalled (repeat)", () => {
		const g = new LoopGuard();
		const text = "I will now check the files and report back.";
		expect(g.observe({ text, usedTool: false })).toEqual({ stalled: false });
		expect(g.observe({ text, usedTool: false })).toEqual({ stalled: false });
		const v = g.observe({ text, usedTool: false });
		expect(v.stalled).toBe(true);
		expect(v.reason).toContain("repeated the same output for 3 turns");
	});

	test("cosmetic differences hash the same (NFKC, case, whitespace)", () => {
		const g = new LoopGuard();
		expect(g.observe({ text: "Check  the FILES now", usedTool: false })).toEqual({ stalled: false });
		expect(g.observe({ text: "check the files   now", usedTool: false })).toEqual({ stalled: false });
		expect(g.observe({ text: "CHECK THE FILES NOW", usedTool: false }).stalled).toBe(true);
	});

	test("A-B-A-B oscillation for 3 cycles → stalled (cycle)", () => {
		const g = new LoopGuard();
		const a = "Plan A: read the config first.";
		const b = "Plan B: grep the source instead.";
		for (let i = 0; i < 2; i++) {
			expect(g.observe({ text: a, usedTool: false }).stalled).toBe(false);
			expect(g.observe({ text: b, usedTool: false }).stalled).toBe(false);
		}
		// 5th turn fills the window to [a,b,a,b,a] — not strict alternation yet.
		expect(g.observe({ text: a, usedTool: false }).stalled).toBe(false);
		// 6th completes a,b,a,b,a,b → 3 full cycles.
		const v = g.observe({ text: b, usedTool: false });
		expect(v.stalled).toBe(true);
		expect(v.reason).toContain("oscillated between two states");
	});

	test("a tool call clears the stall history", () => {
		const g = new LoopGuard();
		const text = "Same plan again.";
		g.observe({ text, usedTool: false });
		g.observe({ text, usedTool: false });
		expect(g.observe({ text, usedTool: true })).toEqual({ stalled: false });
		// history was wiped: two more identical turns are not yet a stall
		expect(g.observe({ text, usedTool: false }).stalled).toBe(false);
		expect(g.observe({ text, usedTool: false }).stalled).toBe(false);
		expect(g.observe({ text, usedTool: false }).stalled).toBe(true);
	});

	test("different text each turn never stalls", () => {
		const g = new LoopGuard();
		for (let i = 0; i < 10; i++) {
			expect(g.observe({ text: `Finding ${i}: file ${i} looks fine, moving on to ${i + 1}.`, usedTool: false }).stalled).toBe(false);
		}
	});

	test("empty turn is not evidence", () => {
		const g = new LoopGuard();
		for (let i = 0; i < 5; i++) expect(g.observe({ text: "   ", usedTool: false })).toEqual({ stalled: false });
	});

	test("parent-poll adaptation: stable tail content across growth stalls", () => {
		// The integration fingerprints the curated tail on every updateCount
		// growth. A spinning child keeps the tail window byte-stable, so the
		// same fingerprint repeats — exactly the repeat shape above.
		const g = new LoopGuard();
		const window = ["[User] do the thing", "thinking out loud", "[Thought] hmm", "thinking out loud"].join("\n");
		expect(g.observe({ text: window, usedTool: false }).stalled).toBe(false);
		expect(g.observe({ text: window, usedTool: false }).stalled).toBe(false);
		expect(g.observe({ text: window, usedTool: false }).stalled).toBe(true);
	});

	test("config from env", () => {
		// v1.4.84 (#91): default OFF — the growth-tick wiring false-killed children
		// that were merely generating a turn (streaming deltas grow updateCount
		// while the curated tail stays frozen until the item completes).
		expect(loopGuardConfigFromEnv({})).toEqual({ enabled: false, repeat: 3, cycle: 3 });
		expect(loopGuardConfigFromEnv({ SUBAGENT_LOOP_GUARD: "1" }).enabled).toBe(true); // explicit opt-in
		expect(loopGuardConfigFromEnv({ SUBAGENT_LOOP_GUARD: "0" }).enabled).toBe(false);
		expect(loopGuardConfigFromEnv({ SUBAGENT_LOOP_REPEAT: "5" }).repeat).toBe(5);
		expect(loopGuardConfigFromEnv({ SUBAGENT_LOOP_REPEAT: "junk" }).repeat).toBe(3);
	});
});
