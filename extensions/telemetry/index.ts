/**
 * Telemetry heartbeat extension (O4, #105) — one atomic JSON per pi process.
 *
 * Borrow (MƯỢN) from pi-telemetry 0.1.3: lifecycle events write
 * ~/.pi/agent/telemetry/instances/<pid>.json (atomic tmp+rename). Consumers
 * read files; staleness (PI_TELEMETRY_STALE_MS, default 120s) = dead. No
 * daemon. Long turns keep updatedAt fresh via a 30s touch timer
 * (PI_TELEMETRY_TOUCH_MS).
 *
 * Events → activity:
 *   session_start   → waiting_input (session up, no turn in flight)
 *   turn_start      → working (+touch timer)
 *   turn_end        → waiting_input (timer cleared)
 *   session_compact → working (tokens may go null right after)
 *   session_shutdown → shutdown marker (file lingers; swept on next start)
 *
 * Escape hatches (docs/escape-hatches.md):
 *   PI_TELEMETRY=0        disable writes entirely
 *   PI_TELEMETRY_DIR=...  relocate (tests use this)
 *   PI_TELEMETRY_STALE_MS / PI_TELEMETRY_TOUCH_MS override thresholds
 *
 * SOC note: payloads carry counts/pressure only — no prompt or log content.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { buildPayload, sweepInstances, type UsageLike } from "./heartbeat.js";
import type { Activity, HeartbeatState, InstancePayload } from "./heartbeat.js";

const DEFAULT_STALE_MS = 120_000;
const DEFAULT_TOUCH_MS = 30_000;

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function telemetryDir(): string {
	return process.env.PI_TELEMETRY_DIR ?? join(process.env.HOME ?? "", ".pi", "agent", "telemetry", "instances");
}

export function instanceFile(pid: number, dir = telemetryDir()): string {
	return join(dir, `${pid}.json`);
}

/** Atomic write: tmp + rename, so a concurrent reader never sees torn JSON. */
export function writeInstance(payload: InstancePayload, file = instanceFile(payload.pid)): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(payload) + "\n", "utf8");
	renameSync(tmp, file);
}

export function readInstance(file: string): InstancePayload | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as InstancePayload;
	} catch {
		return null;
	}
}

function sweep(dir: string, staleMs: number): void {
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	const files = names
		.filter((n) => n.endsWith(".json"))
		.map((name) => ({ name, payload: readInstance(join(dir, name)) }));
	const report = sweepInstances(files, new Date(), staleMs);
	for (const name of report.deleted) {
		try {
			rmSync(join(dir, name));
		} catch {
			// best-effort sweep
		}
	}
}

export default function activate(pi: ExtensionAPI): void {
	if (process.env.PI_TELEMETRY === "0") return;

	const dir = telemetryDir();
	const staleMs = envInt("PI_TELEMETRY_STALE_MS", DEFAULT_STALE_MS);
	const touchMs = envInt("PI_TELEMETRY_TOUCH_MS", DEFAULT_TOUCH_MS);
	const pid = process.pid;
	const state: HeartbeatState = { pid, sessionId: null, startedAt: new Date().toISOString(), turnIndex: null };

	let touchTimer: ReturnType<typeof setInterval> | null = null;
	let lastUsage: UsageLike | null = null;

	const readUsage = (ctx: { getContextUsage?: () => UsageLike | undefined } | undefined): UsageLike | null => {
		try {
			return ctx?.getContextUsage?.() ?? null;
		} catch {
			return null;
		}
	};

	const beat = (activity: Activity) => {
		try {
			writeInstance(buildPayload(state, activity, lastUsage), instanceFile(pid, dir));
		} catch {
			// telemetry must never break the session
		}
	};

	const stopTouch = () => {
		if (touchTimer) {
			clearInterval(touchTimer);
			touchTimer = null;
		}
	};

	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// writes fail silently via beat()'s guard
	}

	pi.on("session_start", (_event, ctx) => {
		try {
			state.sessionId = ctx.sessionManager.getSessionId();
		} catch {
			state.sessionId = null;
		}
		sweep(dir, staleMs);
		beat("waiting_input");
	});

	pi.on("turn_start", (event, ctx) => {
		state.turnIndex = event.turnIndex;
		lastUsage = readUsage(ctx);
		beat("working");
		stopTouch();
		touchTimer = setInterval(() => beat("working"), touchMs);
		if (touchTimer && typeof touchTimer === "object" && "unref" in touchTimer) {
			(touchTimer as { unref(): void }).unref();
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		stopTouch();
		lastUsage = readUsage(ctx);
		beat("waiting_input");
	});

	pi.on("session_compact", () => {
		// tokens may be null immediately after compaction — payload tolerates it
		beat("working");
	});

	pi.on("session_shutdown", () => {
		stopTouch();
		beat("shutdown");
	});
}
