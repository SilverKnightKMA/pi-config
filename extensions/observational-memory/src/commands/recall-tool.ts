/**
 * Model-facing read-only recall tool (#104, v1.4.91).
 *
 * The agent cites observations by id (timestamps) all over status lines and
 * footers; before this tool there was no way to read one back after the
 * consolidator promoted it into topic files. Uses the WHOLE ledger
 * (getEntries(), not the branch) — tombstones and re-records may live on
 * other branches after /tree. Pure logic lives in src/tools/recall.ts; this
 * is only the pi registration (pattern: commands/status-tool.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Entry } from "../ledger/index.js";
import { recallObservation, type RecallResult } from "../tools/recall.js";

const RecallParams = Type.Object({
	id: Type.String({
		description:
			"The observation id — its precise timestamp, e.g. 2026-09-16T21:04:13 or 2026-09-16T21:04:13.07 (ids appear in /om:status lines and om_status output).",
	}),
});

function renderResult(r: RecallResult): string {
	const head = `om_recall ${r.id}: ${r.status}${r.source ? ` (source: ${r.source})` : ""}${r.tombstoned ? " [tombstoned]" : ""}`;
	const obs = r.observation ? `\n  content:    ${r.observation.content}\n  tokenCount: ${r.observation.tokenCount}` : "";
	const note = r.note ? `\n  note: ${r.note}` : "";
	return head + obs + note;
}

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "om_recall",
		label: "Recall an observation by id",
		description:
			"Read back a single observational-memory observation by its id (precise timestamp): returns the " +
			"original content verbatim — even after promotion tombstoned it (v1.4.91 tombstones carry sha256 " +
			"recovery spans). Status: ok (exact original), partial (hash mismatch — suspect), dropped (unrecoverable), " +
			"not_found, invalid_id, source_unavailable. Read-only — safe any time.",
		parameters: RecallParams,
		async execute(_id: string, params: { id: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
			const manager = (ctx as { sessionManager?: { getEntries?: () => Entry[]; getBranch: () => Entry[] } } | undefined)?.sessionManager;
			// Whole ledger, not the branch: recall must survive /tree navigation.
			const entries = manager?.getEntries?.() ?? (manager ? manager.getBranch() : []);
			const result = recallObservation(entries, params.id.trim());
			return { content: [{ type: "text" as const, text: renderResult(result) }], details: result };
		},
	});
}
