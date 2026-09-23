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

/**
 * Local structural types for @pify/task.
 * No imports from pi packages: src/ typechecks and runs standalone.
 */

import type { VerifySpec, TaskAudit } from "./verify.ts";

export const TASK_STATUSES = ["pending", "in_progress", "held", "completed", "cancelled", "parked", "proposed_cancel"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  /** Ids of tasks that must complete before this one may progress. */
  blockedBy: number[];
  /** Reverse links, maintained automatically. */
  blocks: number[];
  /** Required when status becomes completed. */
  evidence: string | null;
  /** Layer-0 verify spec declared at create (absent = plain task). */
  verify?: VerifySpec;
  /** Last layer-1 completion audit (attached on completing a verified task). */
  audit?: TaskAudit;
  /** How many times the verify spec was amended after create (cap enforced at tool layer). */
  verifyAmendments?: number;
  /** Layer-2: consecutive high-confidence judge fails (demote at 2). */
  failStreak?: number;
  /** Layer-2: total judge rounds this task has consumed (cap 3 → park). */
  judgeRounds?: number;
  /** Set when the task was parked via appeal or the round cap — why it waits for the user. */
  appealReason?: string;
  /** v1.4.38 doneCheck guard: how many times the AGENT rewrote the description
   * (cap DESC_AMEND_MAX — beyond that only the user bridge may amend). */
  descAmendments?: number;
  /** v1.4.53 proposal channel: a done-check amendment awaiting user approval on the panel.
   *  A blocked amend (strict/cap) no longer throws — it records a proposal, the user decides. */
  proposals?: TaskProposal[];
  /** v1.4.51 goal membership: a task created while a goal is active gets goalId stamped
   * (snapshot ∪ stamped = membership; the goal-done check is mechanical over this set). */
  goalId?: string;
  /** v1.4.68 plan bridge (#47 Phase B): a step-task born from an APPROVED plan —
   * stamped planId + stepIndex so the plan panel derives step status from the
   * board (registration + verification reuse the task machinery). */
  planId?: string;
  stepIndex?: number;
  /** v1.4.88 #101-hardening: this task is an [AWAITING-USER-DECISION] stage for task #N.
   * Typed field (NOT a description marker — the model can edit descriptions, it
   * cannot touch this): guards read it to keep the pair's existence user-owned. */
  decisionOf?: number;
  /** #242 (v1.4.134): stamped when the task goes terminal (completed/cancelled)
   *  — display/cost-tier metadata for task_list scope + the panel; any later
   *  real touch (content edit or non-terminal status move) clears it. */
  archivedAt?: string;
  /** v1.4.38: append-only diff trail of description rewrites (agent AND user),
   * capped length; the judge packet carries this so layer-2 can weigh
   * self-serving rewrites (live lesson: judge only sees the CURRENT sheet). */
  descHistory?: DescAmendment[];
  createdAt: number;
  updatedAt: number;
}

/** A done-check amendment proposal: drafted by the model, applied only once the user approves (panel). */
export interface TaskProposal {
	id: string;
	at: number;
	from: string;
	to: string;
	reason: string;
	status: "pending" | "applied" | "rejected";
	decidedAt?: number;
	note?: string;
}

/** One doneCheck rewrite: who changed it, when, old→new (truncated). */
export interface DescAmendment {
  at: number;
  by: "agent" | "user" | "goal-lease" | "user-proposal";
  from: string;
  to: string;
}

/** Agent-initiated doneCheck rewrites before the user-only door slams shut. */
export const DESC_AMEND_MAX = 2;

export interface TaskState {
  tasks: Task[];
  nextId: number;
  /** v1.4.69 (#61 Phase C): continuation counters for the task wake loop —
   *  reset whenever the in_progress set changes (new episode). Persisted in
   *  the task ledger (single root snapshot, last wins). */
  wake?: { rounds: number; noProgress: number; signature: string };
  /** #242: one-time legacy terminal stamp ran (ensureLegacyArchive). */
  legacyArchived?: boolean;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/** Nudge thresholds (Claude Code-style reminders). */
export const NUDGE_AFTER_TURNS = 3;
export const MAX_NUDGE_TASKS = 10;
export const MAX_WIDGET_TASKS = 10;

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
