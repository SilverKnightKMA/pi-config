/**
 * Zombie-turn watchdog — DETECT-ONLY (2026-09-01).
 *
 * Why: Paseo daemon loses turn-completion wakes (getpaseo/paseo#3845 / #3847; fix PRs
 * #3848/#3849 still open, v0.7.1 does not contain them). The request dies silently:
 * spinner keeps running, nothing is appended to the session ledger, no error banner
 * ever appears, and nothing retries — because nothing knows it failed. Verified live
 * twice on 2026-09-01 (chat workspace: agent 49cb6161 died after its final thinking
 * 15:56; main session died the same way at 23:03 under freshly-restarted code).
 *
 * What this does in "detect" mode (default): watch in-process activity (message
 * streaming, tool executions, prompt events). A turn idle ≥ stallMs with no tool in
 * flight is a suspected zombie → toast + footer status + one JSONL detection entry
 * (evidence base for a future auto mode). Recovery stays MANUAL and safe:
 * STOP, then type "tiếp tục" — everything already persisted survives.
 *
 * What it deliberately does NOT do: abort or kick the turn itself. A kick while the
 * daemon thinks the turn is running walks straight into the upstream bug family.
 * When #3848/#3849 merge (or our detection log shows a stable signature), flip
 * PI_ZW_MODE=auto and implement recover() below.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TurnWatchdog, type WatchdogSignal } from "./watchdog-core.js";

const LOG_PATH = join(homedir(), ".pi", "agent", "zombie-watchdog.jsonl");
const MODE = (process.env.PI_ZW_MODE ?? "detect") as "detect" | "auto";
const CHECK_INTERVAL_MS = 10_000;

export interface Detection {
	ts: string;
	sessionFile?: string;
	code: string;
	idleMs: number;
}

export function fmtDur(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export interface WireOptions {
	now?: () => number;
	logPath?: string;
}

export function readDetections(logPath: string = LOG_PATH): Detection[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Detection);
}

/** Wire the watchdog into pi. Returns the tick function for tests/manual polling. */
export function wire(pi: ExtensionAPI, opts: WireOptions = {}): () => WatchdogSignal | null {
	const now = opts.now ?? Date.now;
	const logPath = opts.logPath ?? LOG_PATH;
	const wd = new TurnWatchdog();
	let sessionFile: string | undefined;
	let ui: any;
	let timer: ReturnType<typeof setInterval> | undefined;

	function appendDetection(d: Detection): void {
		try {
			appendFileSync(logPath, JSON.stringify(d) + "\n");
		} catch {
			/* best effort */
		}
	}

	function logDetection(sig: WatchdogSignal): void {
		appendDetection({ ts: new Date(now()).toISOString(), sessionFile, code: sig.code, idleMs: sig.idleMs });
	}

	function recover(sig: WatchdogSignal): void {
		// FUTURE (PI_ZW_MODE=auto): kick a continuation, e.g.
		//   pi.sendMessage({ content: "[automatic] request died — continue", display: false }, { triggerTurn: true });
		// Disabled on purpose while the daemon bug family is open; we still log so
		// the evidence base grows either way.
		appendDetection({ ts: new Date(now()).toISOString(), sessionFile, code: "auto-suppressed:" + sig.code, idleMs: sig.idleMs });
	}

	function tick(): WatchdogSignal | null {
		const sig = wd.tick(now());
		if (!sig) return null;
		logDetection(sig);
		if (sig.code !== "tool-stall" && MODE === "auto") recover(sig);
		if (ui) {
			if (sig.code === "tool-stall") {
				ui.notify(`zw: tool chạy ${fmtDur(sig.idleMs)} chưa xong — có thể bình thường (long-run/crawl), cứ để yên`, "info");
			} else {
				const hint = MODE === "auto" ? "auto-recover bị tắt chờ upstream (#3848/#3849)" : 'Bấm STOP rồi gõ "tiếp tục"';
				ui.notify(`zw ⚠ Turn im ${fmtDur(sig.idleMs)} — request có thể đã chết im lặng (bug #3845). ${hint}`, "warning");
				ui.setStatus("zw", `⚠ treo ${fmtDur(sig.idleMs)} — STOP + "tiếp tục"`);
			}
		}
		return sig;
	}

	pi.on("session_start", ((_e: unknown, ctx: any) => {
		sessionFile = ctx?.sessionFile ?? undefined;
		ui = ctx?.hasUI ? ctx.ui : undefined;
		if (timer) clearInterval(timer);
		timer = setInterval(tick, CHECK_INTERVAL_MS);
	}) as never);

	pi.on("turn_start", () => wd.onTurnStart(now()));
	pi.on("turn_end", () => {
		wd.onTurnEnd(now());
		if (ui) ui.setStatus("zw", undefined);
	});
	pi.on("message_start", () => wd.onActivity(now()));
	pi.on("message_update", () => wd.onActivity(now()));
	pi.on("message_end", () => wd.onActivity(now()));
	pi.on("ui_prompt_start", () => wd.onActivity(now()));
	pi.on("ui_prompt_end", () => wd.onActivity(now()));
	pi.on("tool_execution_start", () => wd.onToolStart(now()));
	pi.on("tool_execution_update", () => wd.onActivity(now()));
	pi.on("tool_execution_end", () => wd.onToolEnd(now()));

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.registerCommand("zw", {
		description: "Zombie-watchdog: detection count + last events (silent-dead-turn bug #3845)",
		handler: async (_args: string, ctx: any) => {
			const list = readDetections(logPath);
			if (list.length === 0) {
				if (ctx?.hasUI) ctx.ui.notify("zw: chưa phát hiện turn treo nào ✓", "info");
				return;
			}
			const last = list.slice(-5).map((d) => `${d.ts.slice(0, 19)} ${d.code} idle=${fmtDur(d.idleMs)}`);
			if (ctx?.hasUI) {
				ctx.ui.notify(`zw: ${list.length} lần phát hiện. Gần nhất:\n${last.join("\n")}`, "info");
			}
		},
	});

	return tick;
}

export default function zombieWatchdog(pi: ExtensionAPI): void {
	wire(pi);
}
