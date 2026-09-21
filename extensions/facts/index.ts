/**
 * facts extension — durable facts tier (memory part 2 HYBRID, plan 2026-09-21).
 * P1a (#174): store core only — pure functions re-exported; activate() is a
 * stub so the extension loads clean (smoke gate) but injects nothing yet.
 * P1b (#175) wires session_start / session_compact PUSH injection here.
 *
 * Store: ~/.pi/agent/facts.md — agent NEVER writes it (guard scope, P1d);
 * writers are the deterministic regex trigger (P2) and memory-curator (P3).
 */
export * from "./src/store.ts";

export default function activate(_pi: unknown): void {
	/* P1b: subscribe session_start + session_compact, inject facts block */
}
