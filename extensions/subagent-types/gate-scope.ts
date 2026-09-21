/**
 * gate-scope (#188 standalone-clean layer 2) — does the subagent-types
 * tool_call gate apply to THIS session at all?
 *
 * The gate is a CHILD-containment mechanism. Its anti-spoof posture (a paseo
 * record with no role label → read-only floor) is correct for agents created
 * by paseo. But a human's plain `pi` launched from the CLI has NO record and
 * NO env carrier — it is the machine's most trusted principal, not an
 * untrusted child, and must keep full tools (the #44/#187 standalone
 * invariant). Rule:
 *
 *   gate applies  ⇔  a paseo record was found (myAgentId non-null — including
 *                     unlabelled records, which get the anti-spoof floor)
 *                     OR a machine env carrier is present
 *                     (PASEO_PARENT_AGENT_ID / PASEO_SUBAGENTS_DOOR — covers
 *                     children in the pre-record first-turn race).
 *
 * Neither → human CLI session → gate inactive.
 *
 * A paseo child can never dodge the gate by hiding its origin: extension
 * spawns stamp a record AND carry the env carrier; foreign children get a
 * record before their process starts. Env is fixed at spawn.
 */

/** Machine-spawn markers read from the child's environment (never mutable
 * by the child itself — env is fixed at process start). */
export function hasChildEnvCarrier(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.PASEO_PARENT_AGENT_ID || env.PASEO_SUBAGENTS_DOOR);
}

/** Does the role gate apply? Caller still exempts myRole === "main" itself. */
export function roleGateApplies(
	myAgentId: string | null,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (myAgentId) return true; // paseo record found → machine-managed session
	return hasChildEnvCarrier(env);
}
