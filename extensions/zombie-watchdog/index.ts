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
import { TurnWatchdog, SettleWatch, type WatchdogSignal } from "./watchdog-core.js";
import { findMcpEndpoint, getAgentStatus, isBusy } from "./daemon.js";

const LOG_PATH = join(homedir(), ".pi", "agent", "zombie-watchdog.jsonl");
const MODE = (process.env.PI_ZW_MODE ?? "detect") as "detect" | "auto";
const CHECK_INTERVAL_MS = 10_000;

export interface Detection {
	ts: string;
	sessionFile?: string;
	code: string;
	idleMs: number;
	agentId?: string;
}

export function fmtDur(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export interface WireOptions {
	now?: () => number;
	logPath?: string;
	settle?: Partial<import("./watchdog-core.js").SettleConfig>;
	selfAgentId?: string | null;
	endpoint?: import("./daemon.js").McpEndpoint | undefined;
	fetchImpl?: typeof fetch;
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
	const sw = new SettleWatch(opts.settle ?? {});
	const selfAgentId = opts.selfAgentId ?? process.env.PASEO_AGENT_ID ?? null;
	const endpoint = opts.endpoint ?? findMcpEndpoint(selfAgentId);
	let sessionFile: string | undefined;
	let ui: any;
	let timer: ReturnType<typeof setInterval> | undefined;
	let settleTimers: ReturnType<typeof setTimeout>[] = [];
	let lastProbe: { at: number; status: string | undefined; busy: boolean } | null = null;

	function clearSettleTimers(): void {
		for (const t of settleTimers) clearTimeout(t);
		settleTimers = [];
	}

	async function pollDaemon(endedAt: number): Promise<void> {
		const at = Date.now();
		if (!selfAgentId || !endpoint || !sw.dueCheck(at)) return;
		let busy = false;
		try {
			const r = await getAgentStatus(endpoint, selfAgentId, opts.fetchImpl ?? fetch);
			if (!r.ok) return; // query failed: do not feed garbage
			busy = isBusy(r.status);
			lastProbe = { at: Date.now(), status: r.status, busy };
		} catch {
			return;
		}
		const code = sw.onPoll(Date.now(), busy);
		if (!code) return;
		appendDetection({ ts: new Date().toISOString(), sessionFile, code, idleMs: Date.now() - endedAt, agentId: selfAgentId });
		emitTimeline(`zw ⚠ B2: turn đã xong trong process ${fmtDur(Date.now() - endedAt)} trước nhưng daemon vẫn thấy "running" (settle wake rơi, #3845). Bấm STOP cho sạch`);
		if (ui) {
			ui.notify(`zw ⚠ B2: turn đã xong trong process nhưng daemon vẫn thấy "running" (settle wake bị rơi, #3845). Bấm STOP cho sạch`, "warning");
			ui.setStatus("zw", `⚠ zombie daemon-side — bấm STOP`);
		}
	}

	function armSettleWatch(endedAt: number): void {
		clearSettleTimers();
		if (!selfAgentId || !endpoint) return; // not a Paseo-spawned session
		settleTimers.push(setTimeout(() => void pollDaemon(endedAt), 20_000));
		settleTimers.push(setTimeout(() => void pollDaemon(endedAt), 45_000));
	}

	function appendDetection(d: Detection): void {
		try {
			appendFileSync(logPath, JSON.stringify(d) + "\n");
		} catch {
			/* best effort */
		}
	}

	function emitTimeline(_text: string): void {
		// v2 (2026-09-04, user directive): custom messages enter the model context —
		// the agent must not see watchdog chatter. Detection stays visible via
		// zombie-watchdog.jsonl (Agent Health panel reads it) and the ui.notify
		// toast (terminal runs). Set ZW_TIMELINE_EMISSION=message to restore the
		// legacy in-chat emission (escape hatch until pi grows a UI-only channel).
		if (process.env.ZW_TIMELINE_EMISSION !== "message") return;
		try {
			pi.sendMessage({ customType: "zw-timeline", content: `\n> ${_text}\n`, display: true }, { triggerTurn: false });
		} catch {
			// sendMessage throws during teardown; a missed status line is non-fatal.
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
		emitTimeline(
			sig.code === "tool-stall"
				? `zw: tool chạy ${fmtDur(sig.idleMs)} chưa xong (có thể bình thường)`
				: `zw ⚠ Turn im ${fmtDur(sig.idleMs)} — request chết im lặng (#3845)${MODE === "detect" ? '. Hồi phục: STOP + "tiếp tục"' : " (auto bị tắt chờ upstream)"}`,
		);
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

	pi.on("turn_start", () => {
		wd.onTurnStart(now());
		sw.onTurnStart();
		clearSettleTimers();
	});
	pi.on("turn_end", () => {
		const endedAt = now();
		wd.onTurnEnd(endedAt);
		sw.onTurnEnd(endedAt);
		armSettleWatch(endedAt);
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
		clearSettleTimers();
	});

	pi.registerCommand("zw", {
		description: "Zombie-watchdog: detection count + last events (silent-dead-turn bug #3845)",
		handler: async (_args: string, ctx: any) => {
			const list = readDetections(logPath);
			const probeLine = lastProbe
				? `lần thăm dò gần nhất: ${new Date(lastProbe.at).toLocaleTimeString()} → daemon: ${lastProbe.status ?? "?"}${lastProbe.busy ? " (busy!)" : ""}`
				: "chưa thăm dò lần nào (chưa có turn kết thúc sau khi nạp)";
			if (list.length === 0) {
				if (ctx?.hasUI) ctx.ui.notify(`zw: chưa phát hiện turn treo nào ✓ (${probeLine})`, "info");
				return;
			}
			const last = list.slice(-5).map((d) => `${d.ts.slice(0, 19)} ${d.code} idle=${fmtDur(d.idleMs)}`);
			if (ctx?.hasUI) {
				ctx.ui.notify(`zw: ${list.length} lần phát hiện. ${probeLine}\nGần nhất:\n${last.join("\n")}`, "info");
			}
		},
	});

	return tick;
}

export default function zombieWatchdog(pi: ExtensionAPI): void {
	wire(pi);
}
