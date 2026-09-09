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
import { MAX_WIDGET_TASKS, type Task, type TaskState, type ThemeLike } from "./types.ts";

const WIDTH = 54;

/** Claude Code-style task list widget above the editor. */
export function buildWidgetLines(state: TaskState, theme: ThemeLike): string[] {
  const active = state.tasks.filter((t) => t.status !== "cancelled");
  if (active.length === 0) return [];

  const dim = (s: string) => theme.fg("dim", s);
  const index = new Map(state.tasks.map((t) => [t.id, t]));

  const lines: string[] = [];
  const done = active.filter((t) => t.status === "completed").length;
  const title = ` ☑ tasks ${done}/${active.length} `;
  const hint = " /tasks ";
  const pad = Math.max(1, WIDTH - title.length - hint.length);
  lines.push(dim(`╭${title}${"─".repeat(pad)}${hint}╮`));

  const shown = active.slice(0, MAX_WIDGET_TASKS);
  for (const task of shown) {
    lines.push(`${dim("│ ")}${renderTask(task, index, theme)}`);
  }
  if (active.length > shown.length) {
    lines.push(dim(`│ … +${active.length - shown.length} more`));
  }

  lines.push(dim(`╰${"─".repeat(WIDTH)}╯`));
  return lines;
}

function renderTask(task: Task, index: Map<number, Task>, theme: ThemeLike): string {
  const dim = (s: string) => theme.fg("dim", s);
  const subject = task.subject.length > 38 ? `${task.subject.slice(0, 38)}…` : task.subject;
  const tag = `#${task.id}`;

  switch (task.status) {
    case "completed":
      return dim(`✔ ${tag} ${subject}`);
    case "in_progress":
      return theme.fg("warning", `✳ ${tag} `) + theme.bold(subject);
    case "parked":
      return theme.fg("warning", `⏸ ${tag} ${subject} (chờ user)`);
    default: {
      const open = openBlockers(task, index);
      if (open.length > 0) {
        return dim(`⊘ ${tag} ${subject} (blocked by ${open.map((b) => `#${b}`).join(", ")})`);
      }
      return `◻ ${tag} ${subject}`;
    }
  }
}
