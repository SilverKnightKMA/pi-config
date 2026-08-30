/**
 * Model-facing read-only status tool.
 *
 * Under Paseo the user cannot watch the TUI footer gauges, so the natural way to check
 * observational-memory mid-run is to ask the agent — and the agent needs a tool to answer
 * with. Returns the same numbers as `/om:status` without touching the pipeline, spawning
 * workers, or interrupting a running turn. Never appears in the LLM context unless called.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Entry } from "../ledger/index.js";
import { buildStatusLines } from "./status.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

const StatusParams = Type.Object({});

export function registerStatusTool(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerTool({
		name: "om_status",
		label: "Observational-memory status",
		description:
			"Read the observational-memory pipeline status: in-flight workers, observation buffer, " +
			"pool/consolidator state, topic files, context usage and cumulative worker cost. " +
			"Read-only — safe any time, never interrupts a running turn.",
		parameters: StatusParams,
		async execute(_id: string, _params: Record<string, never>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
			if (!runtime.enabled) {
				return { content: [{ type: "text" as const, text: "observational memory is off (enable with /om on)" }], details: {} };
			}
			// Live ledger branch at call time, same surface the /om:status command reads.
			const manager = (ctx as { sessionManager?: { getBranch: () => Entry[] } } | undefined)?.sessionManager;
			const branch = manager ? manager.getBranch() : [];
			const contextTokens = (ctx as { getContextUsage?: () => { tokens: number } | undefined } | undefined)?.getContextUsage?.()?.tokens ?? null;
			const lines = [
				...buildStatusLines(runtime, branch, contextTokens),
				"",
				renderTimeline(branch, runtime.config),
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
		},
	});
}
