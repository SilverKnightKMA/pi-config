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

export const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
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
  createdAt: number;
  updatedAt: number;
}

export interface TaskState {
  tasks: Task[];
  nextId: number;
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
