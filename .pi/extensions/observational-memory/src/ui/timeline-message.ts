/**
 * RPC-safe feedback channel for observational-memory.
 *
 * Under Paseo the master pi runs in RPC mode, where `ui.notify()` frames are dropped by the
 * daemon while a turn is active (bufferNoTurnOutput returns early when activeTurnStarted) and
 * footer gauges/widgets have no host to render them. The reliable surface is the session
 * transcript itself: a custom message with `display: true` rides `pi.sendMessage` and is
 * rendered on the Paseo timeline (same pattern as the snip extension's status markers).
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
export function makeTimelineSink(pi: SendMessageTarget, opts: { coalesce?: boolean } = {}): TimelineSink {
	const coalesce = opts.coalesce !== false;
	let pending: string[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;

	function emit(lines: string[]): void {
		if (lines.length === 0) return;
		const content = lines.join("\n");
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
