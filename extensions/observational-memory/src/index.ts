/**
 * Observational memory — ORCHESTRATOR (master-side, in-process).
 *
 * The conductor: owns the clocks/triggers, spawns subprocess workers, commits their output to
 * the ledger (observations) or files (long-term, Phase B), renders compaction, and drives the
 * TUI. Event-driven only — no daemon.
 *
 * Ships in the global extensions folder during development, so it is gated OFF by default per
 * session (A2a). When the gate is off, every handler returns at its first line and the
 * extension is completely invisible.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registerCompactCommand } from "./commands/compact.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStatusTool } from "./commands/status-tool.js";
import { registerMemoryGuard } from "./guard/memory-guard.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidatorTrigger } from "./hooks/consolidator-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { OM_ENABLED, type Entry } from "./ledger/index.js";
import { ensureSessionMemory } from "./memory/session.js";
import { Runtime } from "./runtime.js";
import { writeOmStatusSnapshot, type PiSnapshotSource } from "./ui/status-file.js";

function readGateFromLedger(branch: Entry[]): boolean {
	// pipeline stays opt-in: only an explicit `on` entry enables it
	return readGateEx(branch) === true;
}

/** Last explicit gate value; undefined when the session never recorded one. */
function readGateEx(branch: Entry[]): boolean | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === OM_ENABLED) {
			return (entry.data as { enabled?: boolean } | undefined)?.enabled ?? false;
		}
	}
	return undefined;
}

export default function observationalMemory(pi: ExtensionAPI): void {
	const runtime = new Runtime();
	runtime.wireTimeline(pi);
	// v2.1: status file snapshot on demand — real session-scoped cost (ledger
	// getEntries) + live context tokens. Type-erased: PiSnapshotSource is the
	// structural subset we read.
	const piSnap = pi as unknown as PiSnapshotSource;


	function attachIfEnabled(ctx: any): void {
		if (runtime.enabled && ctx.mode === "tui" && ctx.hasUI && ctx.ui) {
			runtime.status.attach(ctx.ui);
		} else {
			runtime.status.detach();
		}
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.dispatchedCoversUpToId = undefined;
		const branch = ctx.sessionManager.getBranch() as Entry[];
		runtime.enabled = readGateFromLedger(branch);
		// memory-guard gate (2026-09-01): on when OM runs here, OR in any fresh
		// session of a project that HAS a .memory tree (spawned subagents: their
		// ledger is empty so readGateFromLedger alone would leave them unguarded
		// — E2E 8d08ad84 proved write/rm sailed through). /om off stays the
		// explicit admin switch-off in the main session.
		runtime.guardActive =
			runtime.enabled ||
			(readGateEx(branch) === undefined && existsSync(join(ctx.cwd ?? process.cwd(), ".memory")));
		if (runtime.enabled) runtime.memoryRoot = ensureSessionMemory(ctx);
		attachIfEnabled(ctx);
		runtime.refreshFooterGauges(branch, ctx.getContextUsage?.()?.tokens ?? null);
		runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
		// v2.1: seed the panel immediately on respawn — no waiting for the first
		// turn_end. Cost comes from the full ledger, so it shows session totals.
		void writeOmStatusSnapshot(runtime, piSnap);
	});

	pi.on("session_shutdown", () => {
		runtime.status.detach();
		runtime.abortAllWorkers();
	});

	pi.registerCommand("om", {
		description: "Toggle observational memory for this session (/om on, /om off)",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !runtime.enabled;
			if (next === runtime.enabled) {
				runtime.timeline.notify(`om already ${next ? "on" : "off"}`);
				if (ctx.hasUI) ctx.ui.notify(`om already ${next ? "on" : "off"}`, "info");
				return;
			}
			runtime.enabled = next;
			runtime.guardActive = next;
			pi.appendEntry(OM_ENABLED, { enabled: next });
			if (next) {
				runtime.memoryRoot = ensureSessionMemory(ctx);
				attachIfEnabled(ctx);
				runtime.refreshFooterGauges(ctx.sessionManager.getBranch() as Entry[], ctx.getContextUsage?.()?.tokens ?? null);
				runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
			} else {
				runtime.abortAllWorkers();
				runtime.status.detach();
			}
			runtime.timeline.notify(`om ${next ? "enabled" : "disabled"}`);
			if (ctx.hasUI) ctx.ui.notify(`om ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	// Triggers + hook self-gate on runtime.enabled / passive at their first line.
	registerObserverTrigger(pi, runtime);
	registerConsolidatorTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerCompactCommand(pi, runtime);
	registerConsolidateCommand(pi, runtime);
	registerStatusTool(pi, runtime);
	// 2026-09-01: per-turn context gauge refresh (footer used to go stale between
	// observer/consolidator events while context grows every turn).
	// 2026-09-05: the status file refreshes on the same cadence so the Paseo
	// panel is current after EVERY chat turn, not only when OM runs fire.
	pi.on("turn_end", (_event: unknown, ctx: any) => {
		runtime.status.updateContext(ctx?.getContextUsage?.()?.tokens ?? null);
		void writeOmStatusSnapshot(runtime, piSnap);
	});

// 2026-09-01: .memory write-guard + context policy line (see guard/memory-guard.ts)
	registerMemoryGuard(pi, () => runtime.guardActive);
}
