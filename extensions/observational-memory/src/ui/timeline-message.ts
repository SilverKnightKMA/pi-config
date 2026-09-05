/**
 * RPC-safe feedback channel for observational-memory.
 *
 * Under Paseo the master pi runs in RPC mode, where `ui.notify()` frames are dropped by the
 * daemon while a turn is active (bufferNoTurnOutput returns early when activeTurnStarted) and
 * footer gauges/widgets have no host to render them. The reliable surface is the session
 * transcript itself: a custom message with `display: true` rides `pi.sendMessage` and is
 * rendered on the Paseo timeline.
 *
 * v2 (2026-09-04, user directive): custom messages are part of the model context — pi
 * feeds agent.state.messages to the provider and the `display` flag only controls UI, so
 * every `> om:` line was read (and occasionally acted on) by the model. OM pipeline chatter
 * must NOT reach the model: the default emission is now a workspace status file consumed
 * by the Paseo om-status plugin panel. Set OM_TIMELINE_EMISSION=message to restore the
 * legacy in-chat emission (escape hatch until pi grows a UI-only message channel).
 *
 * This module is the single seam between the orchestrator and that channel so the rest of the
 * code keeps calling notify-shaped helpers and stays close to upstream.
 */

/** The only pi surface the sink needs: appending a display custom message to the transcript. */
export interface SendMessageTarget {
	sendMessage: (
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean },
	) => void;
}

/** One in-flight/finished worker line for a timeline update. */
export type WorkerLine = { type: "observer" | "consolidator"; state: "running" | "done" | "error"; delta?: number };

/** Prefix every timeline line with the om marker so Paseo can style/filter them. */
const PREFIX = "om:";

function renderWorkerLine(line: WorkerLine): string {
	const delta = line.delta !== undefined && line.delta > 0 ? ` +${line.delta}` : "";
	if (line.state === "running") return `${PREFIX} ${line.type} started`;
	if (line.state === "error") return `${PREFIX} ${line.type} failed`;
	return `${PREFIX} ${line.type} done${delta}`;
}

/** The coalescing timeline sink returned by {@link makeTimelineSink}. */
import type { Runtime } from "../runtime.js";
import { appendOmStatusEvent, type PiSnapshotSource } from "./status-file.js";

export interface TimelineSink {
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	workerLine: (line: WorkerLine) => void;
	flush: () => void;
}

/**
 * Build the notify-shaped helper handed to worker code. Every call lands on the Paseo
 * timeline via a custom message; info lines are coalesced per event-loop tick so parallel
 * observers collapsing in the same tick still all appear (upstream coalesced them into one
 * multi-line notify for the same reason — pi surfaces only the last status line otherwise).
 */
export function makeTimelineSink(pi: SendMessageTarget, opts: { coalesce?: boolean; runtime?: Runtime } = {}): TimelineSink {
	const coalesce = opts.coalesce !== false;
	const runtime = opts.runtime;
	const legacyMessages = process.env.OM_TIMELINE_EMISSION === "message";
	let pending: string[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;

	function emit(lines: string[]): void {
		if (lines.length === 0) return;
		if (runtime && !legacyMessages) {
			// v2: display channel = status file (panel polls), model stays blind.
			// No blockquote wrap here — the panel renders structure itself.
			// pi carries the session ledger: cost lines stay session-scoped
			// (true totals across compaction forks and respawns).
			void appendOmStatusEvent(runtime, lines.join("\n"), pi as unknown as PiSnapshotSource | undefined);
			return;
		}
		// legacy: markdown blockquote as an in-chat custom message
		// 2026-09-01 (user request): om events used to render glued to the nearest
		// agent message in the Paseo UI. Wrap every event batch in a markdown
		// blockquote fenced by blank lines so any renderer shows it as a separate
		// quoted block standing alone — never as a continuation of the agent's text.
		const quoted = lines.map((l) => `> ${l}`).join("\n");
		const content = `\n${quoted}\n`;
		try {
			// triggerTurn:false is load-bearing: without it pi steers the message into the
			// ACTIVE turn (dropped for providers without steer support) instead of appending.
			// With it, a streaming session defers the message to _pendingCustomMessages —
			// flushed at turn end — and an idle session appends immediately.
			pi.sendMessage({ customType: "om-timeline", content, display: true }, { triggerTurn: false });
		} catch {
			// sendMessage throws during teardown; a missed status line is non-fatal.
		}
		pending = [];
	}

	function schedule(): void {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			emit(pending);
		}, 0);
		timer.unref?.();
	}

	function notify(message: string, level?: "info" | "warning" | "error"): void {
		const line = message.startsWith(PREFIX) ? message : `${PREFIX} ${message}`;
		if (!coalesce || (level !== undefined && level !== "info")) {
			emit([line]);
			return;
		}
		pending.push(line);
		schedule();
	}

	return {
		notify,
		workerLine: (line: WorkerLine) => notify(renderWorkerLine(line)),
		flush: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			emit(pending);
		},
	};
}

/** A no-op sink for contexts without a live ExtensionAPI (unit tests, pre-wiring). */
export function makeNullTimelineSink(): TimelineSink {
	return {
		notify: () => {},
		workerLine: () => {},
		flush: () => {},
	};
}
