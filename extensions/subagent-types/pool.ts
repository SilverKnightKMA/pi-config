/**
 * spawn_pool — bounded parallel fan-out over the SANCTIONED spawn path.
 *
 * Borrowed pieces (eval 2026-09-09, briefs pify-workflow-eval + pify-swarm-eval):
 *  - worker-pool with hard concurrency cap (@pify/swarm DEFAULT_CONCURRENCY=4)
 *  - per-item status machine + resume-after-interrupt (@pify/workflow resume.ts)
 *  - deterministic result gate — `expect` substring the child report must
 *    contain, the same declarative-matcher philosophy as task-verify probes.
 * NOT borrowed: swarm's in-process createAgentSession children (invisible to
 * Paseo, bypass the spawn sanction). Every pool child goes through the same
 * createChildAgent/MCP path as spawn_subagent — visible in the app, subject
 * to the same role gates and the same channel report flow.
 *
 * Doctrine guard rails:
 *  - read-mostly roles only: a role is pool-safe when NONE of its tools is a
 *    direct mutating tool (write/edit/bash). Single-writer work stays
 *    sequential — the pool is for scout/researcher-shaped fan-out.
 *  - state is a full snapshot per transition in the session ledger
 *    (appendEntry "pool-state"); respawn replays and pool_resume picks up
 *    where the pool left off (children outlive the parent process).
 *
 * Pure module — no pi imports, no fs, no network. Everything here is
 * deterministic and unit-tested; index.ts owns I/O.
 */

export const POOL_STATE = "pool-state";

export const POOL_MAX_ITEMS = 12; // swarm's cap — enough for the 3-researcher nights, small enough to babysit
export const POOL_DEFAULT_CONCURRENCY = 4;
export const POOL_MAX_CONCURRENCY = 4; // never above the parent-wide SUBAGENT_MAX_CONCURRENT default

/** Child label marking pool membership: the pool driver owns waking main,
 *  so the child's own auto-report backstop stays silent (no per-child pings). */
export const POOL_LABEL = "subagent.pool";
export const MAX_EXPECT_CHARS = 200;
export const MAX_REPORT_CHARS = 2000; // per-item report kept in ledger + aggregate
export const MAX_TASK_CHARS = 4000;

/** Direct write paths. Roles carrying any of these stay OUT of the pool. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

export type PoolItemStatus = "pending" | "running" | "done" | "failed" | "gate_failed" | "timeout";
export type PoolStatus = "running" | "done" | "partial";

export interface PoolItemSpec {
	key: string;
	name?: string;
	role: string;
	task: string;
	model?: string;
	thinking?: string;
	expect?: string;
}

export interface PoolItem extends PoolItemSpec {
	agentId?: string;
	status: PoolItemStatus;
	report?: string;
	error?: string;
	startedAt?: string;
	endedAt?: string;
}

export interface PoolState {
	poolId: string;
	createdAt: string;
	concurrency: number;
	status: PoolStatus;
	items: PoolItem[];
}

export interface RoleLike {
	tools: readonly string[];
}

export type ParseResult = { ok: true; items: PoolItemSpec[]; concurrency: number } | { ok: false; text: string };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/**
 * A role is pool-safe when it exists and none of its tools is a direct
 * mutating tool. safeBonus lets SUBAGENT_POOL_EXTRA_ROLES opt roles in
 * explicitly (escape hatch for unusual setups, e.g. a custom brief-writer
 * role whose only guarded tool is safe_bash).
 */
export function poolSafeRole(role: string, roles: ReadonlyMap<string, RoleLike>, safeBonus: ReadonlySet<string> = new Set()): boolean {
	if (safeBonus.has(role)) return true;
	const def = roles.get(role);
	if (!def) return false;
	return !def.tools.some((t) => MUTATING_TOOLS.has(t));
}

/** Validate raw params (from the tool schema) into item specs. Deterministic, model-free. */
export function parsePoolSpec(
	params: unknown,
	roles: ReadonlyMap<string, RoleLike>,
	safeBonus: ReadonlySet<string> = new Set(),
): ParseResult {
	if (!isRecord(params) || !Array.isArray(params.items)) {
		return { ok: false, text: "spawn_pool needs `items`: an array of 2-12 self-contained tasks." };
	}
	const rawItems = params.items;
	if (rawItems.length < 2) {
		return { ok: false, text: "A 1-item pool is just spawn_paseo_subagent — use that instead." };
	}
	if (rawItems.length > POOL_MAX_ITEMS) {
		return { ok: false, text: `Too many items (${rawItems.length}); the pool caps at ${POOL_MAX_ITEMS}. Split the batch or run sequentially.` };
	}
	const seenKeys = new Set<string>();
	const seenNames = new Set<string>();
	const items: PoolItemSpec[] = [];
	for (let i = 0; i < rawItems.length; i++) {
		const raw = rawItems[i];
		if (!isRecord(raw)) return { ok: false, text: `items[${i}] must be an object.` };
		const role = typeof raw.role === "string" ? raw.role.trim() : "";
		const task = typeof raw.task === "string" ? raw.task.trim() : "";
		if (!role) return { ok: false, text: `items[${i}] is missing \`role\`.` };
		if (!task) return { ok: false, text: `items[${i}] is missing \`task\` (self-contained: the child sees nothing else).` };
		if (task.length > MAX_TASK_CHARS) return { ok: false, text: `items[${i}].task is over ${MAX_TASK_CHARS} chars — split it up.` };
		const key = String(i + 1);
		let name: string | undefined;
		if (raw.name !== undefined) {
			if (typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, text: `items[${i}].name must be a non-empty string.` };
			name = raw.name.trim();
			if (seenNames.has(name)) return { ok: false, text: `Duplicate name "${name}" — names must be unique inside a pool.` };
			seenNames.add(name);
		}
		let expect: string | undefined;
		if (raw.expect !== undefined) {
			if (typeof raw.expect !== "string" || !raw.expect.trim()) return { ok: false, text: `items[${i}].expect must be a non-empty substring the report must contain.` };
			expect = raw.expect.trim();
			if (expect.length > MAX_EXPECT_CHARS) return { ok: false, text: `items[${i}].expect is over ${MAX_EXPECT_CHARS} chars.` };
		}
		if (seenKeys.has(key)) return { ok: false, text: `Duplicate key "${key}".` };
		seenKeys.add(key);
		items.push({
			key,
			...(name !== undefined ? { name } : {}),
			role,
			task,
			...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
			...(typeof raw.thinking === "string" && raw.thinking.trim() ? { thinking: raw.thinking.trim() } : {}),
			...(expect !== undefined ? { expect } : {}),
		});
	}
	const unsafe = items.filter((it) => !poolSafeRole(it.role, roles, safeBonus));
	if (unsafe.length > 0) {
		const safe = [...roles.keys()].filter((r) => poolSafeRole(r, roles, safeBonus));
		return {
			ok: false,
			text: `Pool rejects write-capable roles (single-writer doctrine — mutating work stays sequential): ${unsafe.map((it) => `#${it.key} ${it.role}`).join(", ")}. Pool-safe roles: ${safe.join(", ") || "(none)"}.`,
		};
	}
	const asked = typeof params.concurrency === "number" ? params.concurrency : POOL_DEFAULT_CONCURRENCY;
	const concurrency = Math.max(1, Math.min(POOL_MAX_CONCURRENCY, Math.floor(asked)));
	return { ok: true, items, concurrency };
}

export function initPool(poolId: string, items: PoolItemSpec[], concurrency: number, now = new Date().toISOString()): PoolState {
	return {
		poolId,
		createdAt: now,
		concurrency,
		status: "running",
		items: items.map((spec) => ({ ...spec, status: "pending" as const })),
	};
}

/** Items that may start NOW: pending ones, bounded by free slots. */
export function nextToStart(state: PoolState): PoolItem[] {
	const running = state.items.filter((i) => i.status === "running").length;
	const free = Math.max(0, state.concurrency - running);
	return state.items.filter((i) => i.status === "pending").slice(0, free);
}

export function markRunning(state: PoolState, key: string, agentId: string, at = new Date().toISOString()): void {
	const item = state.items.find((i) => i.key === key);
	if (!item || item.status !== "pending") return;
	item.status = "running";
	item.agentId = agentId;
	item.startedAt = at;
}

/**
 * Deterministic result gate: when the item declared `expect`, a done report
 * must contain that substring — else the item lands gate_failed and the
 * aggregate says so. Never consults a model.
 */
export function gateCheck(expect: string | undefined, report: string | undefined): { ok: true } | { ok: false; reason: string } {
	if (!expect) return { ok: true };
	const text = report ?? "";
	if (!text.includes(expect)) {
		return { ok: false, reason: `report does not contain the declared substring "${expect}"` };
	}
	return { ok: true };
}

export function finishItem(
	state: PoolState,
	key: string,
	result: { status: "done" | "failed"; report?: string; error?: string },
	at = new Date().toISOString(),
): void {
	const item = state.items.find((i) => i.key === key);
	if (!item || (item.status !== "running" && item.status !== "timeout" && item.status !== "pending")) return;
	if (result.status === "done") {
		const gate = gateCheck(item.expect, result.report);
		item.status = gate.ok ? "done" : "gate_failed";
		item.report = clip(result.report ?? "", MAX_REPORT_CHARS);
		if (!gate.ok) item.error = gate.reason;
	} else {
		item.status = "failed";
		item.error = clip(result.error ?? "spawn/child error", MAX_REPORT_CHARS);
	}
	item.endedAt = at;
}

/** Deadline hit: running items become timeout (resumable); pending stay pending. */
export function timeoutRunning(state: PoolState, at = new Date().toISOString()): void {
	for (const item of state.items) {
		if (item.status === "running") {
			item.status = "timeout";
			item.endedAt = at;
		}
	}
}

export function unfinished(state: PoolState): boolean {
	return state.items.some((i) => i.status === "pending" || i.status === "running" || i.status === "timeout");
}

export function refreshPoolStatus(state: PoolState): void {
	state.status = !unfinished(state) ? "done" : "partial";
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const GLYPH: Record<PoolItemStatus, string> = {
	pending: "·",
	running: "▶",
	done: "✓",
	failed: "✗",
	gate_failed: "△",
	timeout: "⏱",
};

/** One compact text report for the whole pool — the aggregation swarm got right. */
export function aggregateReport(state: PoolState): string {
	const counts = new Map<PoolItemStatus, number>();
	for (const i of state.items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
	const parts: string[] = [];
	parts.push(`Pool ${state.poolId} — ${counts.get("done") ?? 0}/${state.items.length} done` + (state.status === "done" ? " (complete)" : " (partial — pool_resume to continue)"));
	for (const extra of ["gate_failed", "failed", "timeout", "running", "pending"] as PoolItemStatus[]) {
		const n = counts.get(extra) ?? 0;
		if (n > 0) parts.push(`${GLYPH[extra]} ${extra}: ${n}`);
	}
	parts.push("");
	for (const item of state.items) {
		const label = item.name ? `#${item.key} ${item.role} "${item.name}"` : `#${item.key} ${item.role}`;
		let tail: string;
		if (item.status === "gate_failed") tail = item.error ?? "gate failed";
		else if (item.status === "failed") tail = item.error ?? "failed";
		else if (item.status === "timeout") tail = `agent ${item.agentId ?? "?"} still running — pool_resume("${state.poolId}") re-checks it`;
		else if (item.status === "running") tail = "in flight…";
		else if (item.status === "pending") tail = "queued (cap)";
		else tail = oneLine(item.report ?? "(no output)", 240);
		parts.push(`${GLYPH[item.status]} ${label}: ${tail}`);
	}
	if (unfinished(state)) {
		parts.push("");
		parts.push(`Unfinished items survive respawn: pool_status lists pools, pool_resume("${state.poolId}") spawns queued items and re-checks running ones.`);
	}
	return parts.join("\n");
}

/** What resume has to do: spawn queued items, re-check timed-out/running agents. */
export function resumePlan(state: PoolState): { spawn: PoolItem[]; recheck: PoolItem[] } {
	return {
		spawn: state.items.filter((i) => i.status === "pending"),
		recheck: state.items.filter((i) => (i.status === "timeout" || i.status === "running") && !!i.agentId),
	};
}

/** Immediate reply for a detached pool: the tool call ends at once, the
 *  harness drives the wave in the background and delivers ONE aggregate
 *  message on completion (v1.4.44 — keeps the main turn short so a user
 *  message never hits the daemon's replace-run cancel window). */
export function detachReply(state: PoolState, timeoutMs: number): string {
	const queued = state.items.filter((i) => i.status === "pending").length;
	const mins = Math.max(1, Math.round(timeoutMs / 60_000));
	return [
		`Pool ${state.poolId} DETACHED — running in the background; this turn is free now.`,
		`${state.items.length} items · concurrency ${state.concurrency} · ${queued} queued.`,
		`ONE aggregate report arrives as a message when the pool completes (or ~${mins}min timeout). pool_status peeks anytime; pool_resume refills after a crash.`,
	].join("\n");
}

/** Ledger-safe rebuild: full-snapshot entries, last one per pool wins. */
export function sanitizePoolState(raw: unknown): PoolState | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.poolId !== "string" || !raw.poolId) return null;
	if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > POOL_MAX_ITEMS) return null;
	const items: PoolItem[] = [];
	for (const r of raw.items) {
		if (!isRecord(r) || typeof r.key !== "string" || typeof r.role !== "string" || typeof r.task !== "string") return null;
		const status = r.status;
		if (typeof status !== "string" || !["pending", "running", "done", "failed", "gate_failed", "timeout"].includes(status)) return null;
		items.push({
			key: r.key,
			...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
			role: r.role,
			task: clip(r.task, MAX_TASK_CHARS),
			...(typeof r.model === "string" && r.model ? { model: r.model } : {}),
			...(typeof r.thinking === "string" && r.thinking ? { thinking: r.thinking } : {}),
			...(typeof r.expect === "string" && r.expect ? { expect: r.expect } : {}),
			...(typeof r.agentId === "string" && r.agentId ? { agentId: r.agentId } : {}),
			status: status as PoolItemStatus,
			...(typeof r.report === "string" ? { report: clip(r.report, MAX_REPORT_CHARS) } : {}),
			...(typeof r.error === "string" ? { error: clip(r.error, MAX_REPORT_CHARS) } : {}),
			...(typeof r.startedAt === "string" ? { startedAt: r.startedAt } : {}),
			...(typeof r.endedAt === "string" ? { endedAt: r.endedAt } : {}),
		});
	}
	const status = raw.status === "done" ? "done" : unfinished({ poolId: "", createdAt: "", concurrency: 1, status: "running", items }) ? "partial" : "done";
	return {
		poolId: raw.poolId,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
		concurrency: typeof raw.concurrency === "number" && raw.concurrency >= 1 ? Math.min(POOL_MAX_CONCURRENCY, Math.floor(raw.concurrency)) : POOL_DEFAULT_CONCURRENCY,
		status,
		items,
	};
}

export interface BranchEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** Replay pools from the session branch (compaction-safe: full snapshots). */
export function replayPools(entries: readonly BranchEntryLike[]): Map<string, PoolState> {
	const pools = new Map<string, PoolState>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== POOL_STATE) continue;
		const state = sanitizePoolState(entry.data);
		if (state) pools.set(state.poolId, state);
	}
	return pools;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
