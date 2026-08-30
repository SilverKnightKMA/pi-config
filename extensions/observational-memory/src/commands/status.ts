import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCostByRole, type Entry } from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
import { estimateStringTokens } from "../tokens.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

/**
 * Shared status renderer — the single source of truth for both the /om:status
 * command and the om_status tool. Grouped into sections with a verdict line up
 * front (the one line most reads need), ratios instead of bare numbers, and
 * per-role cost attribution so spend can be traced to observer vs consolidator.
 */
export function buildStatusLines(runtime: Runtime, branch: Entry[], contextTokens: number | null): string[] {
	const cfg = runtime.config;
	const folded = foldLedger(branch);
	const pool = poolTokens(folded.activeObservations);
	const since = rawTokensSinceObservationCoverage(branch);
	const topics = listTopics(runtime.memoryRoot);
	const journey = readJourney(runtime.memoryRoot);
	const cost = sumSessionCostByRole(branch);

	const running = runtime.observersInFlight.size;
	const pct = (v: number, max: number) => `${Math.round((v / max) * 100)}%`;
	const k = (t: number) => `${(t / 1000).toFixed(1)}k`;

	const warnings: string[] = [];
	if (runtime.lastWorkerError) warnings.push("last worker error (see bottom)");
	if (pool >= cfg.consolidateAtPoolTokens * 0.9) warnings.push(`pool ${pct(pool, cfg.consolidateAtPoolTokens)} — consolidation imminent`);
	if (contextTokens != null && contextTokens >= cfg.compactAtContextTokens * 0.8)
		warnings.push(`context ${pct(contextTokens, cfg.compactAtContextTokens)} — compaction due soon`);

	const verdict =
		runtime.consolidatorInFlight || running > 0
			? `⏳ working — ${[running > 0 ? `${running}/${cfg.observerConcurrency} observers` : null, runtime.consolidatorInFlight ? "consolidator" : null]
					.filter(Boolean)
					.join(" + ")}`
			: warnings.length > 0
				? `⚠ ${warnings.join("; ")}`
				: "✓ healthy";

	const pendingSlices = Math.ceil(since / cfg.chunkTokens);

	return [
		`om status — ${verdict}`,
		"",
		"Workers",
		`  observers: ${running}/${cfg.observerConcurrency} running · ${pendingSlices} slice(s) of chat waiting to be summarized (~${k(since)} tok)`,
		`  consolidator: ${runtime.consolidatorInFlight ? "running" : "idle"}`,
		"",
		"Buffer",
		`  pool: ${pool.toLocaleString()} tok (${pct(pool, cfg.consolidateAtPoolTokens)} of consolidate-at ${cfg.consolidateAtPoolTokens.toLocaleString()}; drains to ${cfg.poolTargetTokens.toLocaleString()})`,
		`  next slice: ${since.toLocaleString()} / ${cfg.chunkTokens.toLocaleString()} tok`,
		"",
		"Context & files",
		`  context: ${contextTokens != null ? `${contextTokens.toLocaleString()} / ${cfg.compactAtContextTokens.toLocaleString()} tok (${pct(contextTokens, cfg.compactAtContextTokens)})` : "?"}`,
		`  topics (durable): ${topics.length} · journey: ${journey ? `~${estimateStringTokens(journey).toLocaleString()} / ${cfg.journeyTargetTokens.toLocaleString()} tok` : "none yet"}`,
		"",
		"Cost",
		`  session: $${cost.total.costUsd.toFixed(4)} (${cost.total.runs} runs)`,
		`    observer      $${cost.observer.costUsd.toFixed(4)} (${cost.observer.runs} runs)`,
		`    consolidator  $${cost.consolidator.costUsd.toFixed(4)} (${cost.consolidator.runs} runs)`,
		"",
		`  last error: ${runtime.lastWorkerError ?? "none"}`,
	];
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational-memory status (verdict, workers, buffer, files, cost)",
		handler: async (_args: string, ctx: any) => {
			if (!runtime.enabled) {
				runtime.timeline.notify("om is off (use /om on to enable)");
				if (ctx.hasUI) ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const lines = [
				...buildStatusLines(runtime, branch, ctx.getContextUsage?.()?.tokens ?? null),
				"",
				renderTimeline(branch, runtime.config),
			];
			// Paseo timeline first (survives mid-turn); TUI keeps its notify popup.
			runtime.timeline.notify(lines.join("\n"));
			ctx.ui?.notify(lines.join("\n"), "info");
		},
	});
}
