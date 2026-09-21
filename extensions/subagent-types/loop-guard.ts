/**
 * Stop a child that has stopped making progress. Ported from @pify/swarm 0.8.0
 * (MIT, pifydev) — SYNC-UPSTREAM 2026-09-14, task #60.
 *
 * A turn cap bounds what a runaway child can cost; it does not notice the
 * characteristic autonomous-agent failure, which is cheaper per turn and just
 * as stuck: restating the same plan every turn without calling a tool, or
 * oscillating between two states forever. pi's own loop will happily let that
 * run to the cap.
 *
 * ADAPTATION (parent-poll architecture): upstream subscribes to the child's
 * in-process `message_end`. Our pool children are separate Paseo agents — the
 * parent only polls. So the integration in index.ts observes on timeline
 * GROWTH (daemon `get_agent_activity.updateCount` increases) and fingerprints
 * the curated tail content: a child repeating/oscillating identical output
 * keeps its tail window stable across growth, while any real progress (tool
 * calls, new text) mutates it. `usedTool` therefore stays false from the
 * poller — progress is detected by content mutation, and an identical tool
 * call repeated back-to-back ALSO stalls (upstream would call any tool call
 * progress; we treat a frozen tool loop as a loop too). A silent child (long
 * bash, no output) never grows and is never observed — no false stall.
 *
 * Zero dependencies — node:crypto for the hash. Deterministic and pure given
 * the sequence of turns, so it is unit-testable without a live child.
 */
import { createHash } from "node:crypto";

export interface LoopGuardConfig {
	/** Consecutive identical tool-free turns before flagging a stall (min 2, default 3). */
	repeat?: number;
	/** Repeats of a two-turn A-B cycle before flagging (min 2, default 3). */
	cycle?: number;
}

export interface Turn {
	/** The visible assistant text of the turn. */
	text: string;
	/** Did the turn invoke at least one tool? A tool call is progress. */
	usedTool: boolean;
}

export interface LoopVerdict {
	stalled: boolean;
	reason?: string;
}

/** Fold away cosmetic differences so "the same thought" hashes the same. */
function fingerprint(text: string): string {
	const norm = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
	return createHash("sha256").update(norm).digest("hex");
}

export class LoopGuard {
	private readonly repeat: number;
	private readonly cycle: number;
	/** Recent tool-free fingerprints; a tool call clears this. */
	private readonly recent: string[] = [];
	private static readonly MAX = 16;

	constructor(cfg: LoopGuardConfig = {}) {
		this.repeat = Math.max(2, cfg.repeat ?? 3);
		this.cycle = Math.max(2, cfg.cycle ?? 3);
	}

	observe(turn: Turn): LoopVerdict {
		// A tool call is forward motion: forget the stall history entirely.
		if (turn.usedTool) {
			this.recent.length = 0;
			return { stalled: false };
		}
		// A silent turn (no text, no tool) is not evidence of a loop by itself.
		if (turn.text.trim() === "") return { stalled: false };

		const fp = fingerprint(turn.text);
		this.recent.push(fp);
		if (this.recent.length > LoopGuard.MAX) this.recent.shift();

		// Spinning in place: the last `repeat` tool-free turns are identical.
		if (this.recent.length >= this.repeat && this.recent.slice(-this.repeat).every((f) => f === fp)) {
			return { stalled: true, reason: `repeated the same output for ${this.repeat} turns without acting` };
		}

		// Oscillating: the last 2xcycle turns are a strict A-B-A-B… alternation.
		const need = 2 * this.cycle;
		if (this.recent.length >= need) {
			const tail = this.recent.slice(-need);
			const a = tail[0]!;
			const b = tail[1]!;
			if (a !== b && tail.every((f, i) => f === (i % 2 === 0 ? a : b))) {
				return { stalled: true, reason: `oscillated between two states for ${this.cycle} cycles without acting` };
			}
		}

		return { stalled: false };
	}
}

/** Loop-guard settings from env. Default OFF since v1.4.84 (#91): the
 *  poller wiring cannot distinguish "generating a new turn" (updateCount
 *  grows on every streaming delta while the curated tail stays frozen until
 *  the item completes) from a true repeat — 6s of thinking got productive
 *  researchers killed mid-turn (15 false kills, 0 true positives). Opt in
 *  explicitly with SUBAGENT_LOOP_GUARD=1 once a turn-boundary signal exists. */
export function loopGuardConfigFromEnv(env: Record<string, string | undefined> = process.env): LoopGuardConfig & { enabled: boolean } {
	const enabled = env.SUBAGENT_LOOP_GUARD === "1";
	const repeat = Number.parseInt(env.SUBAGENT_LOOP_REPEAT ?? "", 10);
	return { enabled, repeat: Number.isFinite(repeat) ? repeat : 3, cycle: 3 };
}
