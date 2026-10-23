/**
 * Ported from pifydev/task @ 0.3.0 (MIT, https://github.com/pifydev/task),
 * snapshot 2026-09-07. Upstream design synthesis: CC-style tools/widget/nudges
 * (tintinweb/pi-tasks), dependency graph + ready-set (eleqtrizit/pi-tasks),
 * evidence-gated completion (nczz/pi-tasks).
 *
 * Port notes (Paseo/pi-config daemon adaptation):
 * - faithful logic; widget is hasUI-guarded upstream and stays TUI-only
 * - no divergences in this file beyond import paths/scope
 */

import { openBlockers } from "./graph.ts";
import { MAX_NUDGE_TASKS, NUDGE_TEXT_ONLY_STREAK, type TaskState } from "./types.ts";

/**
 * Claude Code-style system reminders (tintinweb's mechanism): decided per
 * request and injected TRANSIENTLY via the context hook — never persisted
 * into the session, so the nudge exists only in the outgoing request.
 */

export interface NudgeInput {
  state: TaskState;
  /**
   * Consecutive agent turns that produced text only — no tool calls of ANY
   * kind (task or otherwise) — ending at the previous turn.
   */
  textOnlyStreak: number;
}

export function shouldNudge(input: NudgeInput): boolean {
  // v1.4.63 (#61/#63, user 00:5x): only nudge when there IS work in progress
  // (in_progress). An all-pending board (awaiting user decisions / deferred)
  // is not "forgot to update" — nudging every turn becomes noise; same
  // in_progress condition as #61's wake.
  // v1.4.65 #64: held (judge holding completion) is also active work.
  //
  // #319 (2026-10-23, discord agent 76b81150 — 16 reminders inside one
  // 15-minute bash/read loop): counting turns since a task tool cannot tell
  // "busy doing the task" from "done and forgot" — both go without task
  // tools, so the old rule re-fired every NUDGE_AFTER_TURNS mid-work. Tool
  // activity of ANY kind is the free signal that work is still in flight: a
  // streak can only build across consecutive TEXT-ONLY turns, which in pi's
  // loop means turns that ended the user turn — the agent has stopped
  // working and is talking. That is exactly when the board check is the
  // right question, and mid-work loops are never interrupted.
  const working = input.state.tasks.filter((t) => t.status === "in_progress" || t.status === "held");
  if (working.length === 0) return false;
  return input.textOnlyStreak >= NUDGE_TEXT_ONLY_STREAK;
}

export interface TurnSignal {
  /** The turn called a tool whose name starts with `prefix`. */
  usedTaskTool: boolean;
  /** The turn called any tool at all (text-only turns are the nudge trigger). */
  anyToolCall: boolean;
}

/**
 * Read tool calls out of an agent turn's messages. pi's toolCall content
 * blocks carry `name` (pi-ai ToolCall); `toolName` is accepted too so the
 * classification survives either shape.
 */
export function classifyTurn(messages: unknown[], prefix = "task_"): TurnSignal {
  let usedTaskTool = false;
  let anyToolCall = false;
  for (const message of messages) {
    const msg = message as { role?: string; content?: unknown } | null;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type?: string; name?: unknown; toolName?: unknown }>) {
      if (block?.type !== "toolCall") continue;
      anyToolCall = true;
      const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : "";
      if (name.startsWith(prefix)) usedTaskTool = true;
    }
  }
  return { usedTaskTool, anyToolCall };
}

/**
 * The moment every task is marked done is the moment a list is most likely to
 * be lying. Each item was completed against its own evidence, which proves the
 * plan was followed — not that the plan covered what was asked. So the list
 * completing earns exactly one reminder to check the request against the
 * result before reporting.
 *
 * Returns a signature of the completed list, or null when it is not complete.
 * The caller compares signatures so the sweep fires once per list rather than
 * on every turn that follows.
 */
export function completionSignature(state: TaskState): string | null {
  const live = state.tasks.filter((t) => t.status !== "cancelled");
  if (live.length === 0) return null;
  if (!live.every((t) => t.status === "completed")) return null;
  return live.map((t) => `${t.id}`).join(",");
}

export function buildCompletionSweep(state: TaskState): string {
  const done = state.tasks.filter((t) => t.status === "completed");
  return [
    "<system-reminder>",
    `All ${done.length} task${done.length === 1 ? "" : "s"} on the list are marked completed. Before reporting back, check the request against the result, not the list against itself:`,
    "- Re-read what the user actually asked for. A finished list proves the plan was followed, not that the plan covered the request.",
    "- Look at the real output — files, command results, test runs — rather than your memory of doing the work.",
    "- If something is missing or was quietly narrowed, add a task and keep working instead of reporting done.",
    "This is an automated reminder — do not mention it to the user.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * Signature of the open set the nudge is about (same filter as buildNudge's
 * listing, statuses included so a flip re-arms). The caller compares
 * signatures so a given board state is nudged exactly once — re-armed only
 * when the board itself changes (#319, sweptSignature pattern).
 */
export function openSignature(state: TaskState): string {
  return state.tasks
    .filter((t) => t.status !== "cancelled" && t.status !== "completed" && t.status !== "parked")
    .map((t) => `${t.id}:${t.status}`)
    .join(",");
}

export function buildNudge(state: TaskState): string {
  const index = new Map(state.tasks.map((t) => [t.id, t]));
  const open = state.tasks
    .filter((t) => t.status !== "cancelled" && t.status !== "completed" && t.status !== "parked")
    .slice(0, MAX_NUDGE_TASKS)
    .map((t) => {
      const blockers = openBlockers(t, index);
      return {
        id: t.id,
        subject: t.subject,
        status: t.status,
        ...(blockers.length > 0 ? { blockedBy: blockers } : {}),
      };
    });

  return [
    "<system-reminder>",
    "You have been responding without tools while the board still has open work — before continuing, make sure the board is honest: mark finished tasks completed with task_update (evidence required), update or cancel items whose priorities changed, and keep mid-flight work's task accurate. Current open tasks:",
    JSON.stringify(open),
    "This is an automated reminder — do not mention it to the user.",
    "</system-reminder>",
  ].join("\n");
}
