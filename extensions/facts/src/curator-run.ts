/**
 * memory-curator runner — engine side of P3 (#180).
 *
 * Orchestrates one curation run: threshold check → bounded evidence pack →
 * one-shot READ-ONLY planner worker (`memory-curator-<ts>`, a recorded global
 * pi session like OM workers) → deterministic validatePlan gate → atomic
 * apply (tmp+rename) → receipt + state update. Failure modes (plan 2026-09-21):
 *   - planner crash / garbage JSON → refuse the WHOLE plan (fail-closed),
 *     failingStreak++ → next run self-heals the debt (counters stay crossed);
 *   - crash mid-write → rename keeps the old file intact;
 *   - repeat failure → failingStreak kept in state for the panel chip (P4).
 *
 * Spawning is injected for tests (plannerSpawn).
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	applyPlan,
	buildReceipt,
	curatorThresholds,
	initialCuratorState,
	sha256Content,
	shouldRunCurator,
	validatePlan,
	type CuratorState,
} from "./curator-core.ts";
import { factsFilePath, parseFactsFile, serializeFacts, todayIso } from "./store.ts";

export const MAX_PACK_BYTES = 100 * 1024; // ≤~100KB evidence ration (plan 2026-09-21)

// --- paths ------------------------------------------------------------------------

export function factsRunsDir(env: NodeJS.ProcessEnv = process.env, home = process.env.HOME ?? ""): string {
	return env.FACTS_RUNS_DIR && env.FACTS_RUNS_DIR.trim()
		? env.FACTS_RUNS_DIR
		: join(home, ".pi", "agent", "facts-runs");
}

function statePath(env: NodeJS.ProcessEnv, home: string): string {
	return join(factsRunsDir(env, home), "curator-state.json");
}

function nonEmptyLines(content: string): number {
	return content.split("\n").filter((l) => l.trim()).length;
}

// --- planner spawn -------------------------------------------------------------------

/** Resolve the `pi` entry point (OM workers' trick). */
function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {
			/* fall through */
		}
	}
	return { command: "pi", baseArgs: [] };
}

export type PlannerSpawn = (pack: string, sessionName: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Real spawn: headless `pi -p` planner, read-only (no tools, no extensions),
 *  prompt via stdin (argv length ceiling), stdout captured, 120s kill. */
export function realPlannerSpawn(env: NodeJS.ProcessEnv = process.env): PlannerSpawn {
	return (pack, sessionName) =>
		new Promise((resolve) => {
			const pi = resolvePiBinary();
			const args = [
				...pi.baseArgs,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-builtin-tools",
				"-n",
				sessionName,
				"-p",
			];
			if (env.FACTS_CURATOR_MODEL) args.push("--model", env.FACTS_CURATOR_MODEL);
			const cwd = factsRunsDir(env);
			mkdirSync(cwd, { recursive: true });
			const proc = spawn(pi.command, args, {
				cwd,
				env: { ...env, FACTS_WORKER: "1" }, // sanctioned writer exempt (future use)
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let killed = false;
			const timer = setTimeout(() => {
				killed = true;
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.();
			}, 120_000);
			timer.unref?.();
			proc.stdin?.on("error", () => {});
			proc.stdin?.end(pack);
			proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
			proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
			proc.on("error", () => {
				clearTimeout(timer);
				resolve({ code: 1, stdout, stderr: stderr || "spawn error" });
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				if (killed) stderr += "\n[curator] planner timed out after 120s";
				resolve({ code, stdout, stderr });
			});
		});
}

// --- evidence pack ------------------------------------------------------------------

export function buildEvidencePack(opts: {
	factsRaw: string;
	triggerLogTail: string; // new trigger.log entries since last run
	lessonsTail: string; // newest lesson lines
}): { pack: string; bytes: number } {
	const sections = [
		"=== FACTS STORE (verbatim) ===",
		opts.factsRaw.slice(0, 60 * 1024),
		"=== TRIGGER LOG (new entries since last curation) ===",
		opts.triggerLogTail.slice(-8 * 1024),
		"=== LESSONS (newest) ===",
		opts.lessonsTail.slice(-8 * 1024),
	].join("\n");
	const instructions = [
		"",
		"=== INSTRUCTIONS ===",
		"You are the memory-curator: a READ-ONLY staleness reviewer. Score each LIVE fact line against the",
		"evidence above. Reply with EXACTLY ONE JSON object and nothing else — no prose, no markdown fence:",
		'{"verdicts":[{"id":"<6-hex>","verdict":"KEEP|CONTRADICTED|SUPERSEDED|SUBSUMED|DORMANT|ONE-SHOT","evidence":"<short quote/ground>"}],',
		'"proposals":[{"category":"identity|preference|convention|project|decision|ops","date":"YYYY-MM-DD","priority":"P1|P2|P3","text":"<one line>","source":"<ground>"}]}',
		"Rules: verdict only what the evidence shows; every verdict NEEDS evidence; tombstone at most 20% of live",
		"lines in one run; proposals only for facts clearly missing and grounded; 0-5 proposals; when unsure → KEEP.",
	].join("\n");
	const pack = sections + instructions;
	return { pack, bytes: Buffer.byteLength(pack, "utf8") };
}

// --- state --------------------------------------------------------------------------

export function readCuratorState(env: NodeJS.ProcessEnv, home: string): CuratorState {
	try {
		const raw = JSON.parse(readFileSync(statePath(env, home), "utf8"));
		if (raw && typeof raw === "object" && typeof raw.factsBaseline === "number") return raw as CuratorState;
	} catch {
		/* missing/corrupt → fresh */
	}
	return initialCuratorState();
}

export function writeCuratorState(st: CuratorState, env: NodeJS.ProcessEnv, home: string): void {
	const dir = factsRunsDir(env, home);
	mkdirSync(dir, { recursive: true });
	writeFileSync(statePath(env, home), JSON.stringify(st, null, "\t") + "\n");
}

/** Engine counter update at every session_shutdown. */
export function accrueCounters(env: NodeJS.ProcessEnv, home: string, sessionTokens: number): CuratorState {
	const st = readCuratorState(env, home);
	st.tokensSinceRun += Math.max(0, Math.floor(sessionTokens));
	st.sessionsSinceRun += 1;
	writeCuratorState(st, env, home);
	return st;
}

// --- one run ------------------------------------------------------------------------

export type RunOutcome =
	| { ran: false; reason: string }
	| { ran: true; outcome: "ok" | "refused" | "error"; detail: string; receiptFile?: string };

const MAX_ATTEMPTS = 2; // plan: retry once, then leave the debt for the next crossing
const backoffMs = (env: NodeJS.ProcessEnv): number => {
	const n = Number.parseInt(env.FACTS_CURATOR_BACKOFF_MS ?? "", 10);
	return Number.isNaN(n) ? 5_000 : Math.min(60_000, Math.max(0, n));
};

export async function runCuratorOnce(opts: {
	env?: NodeJS.ProcessEnv;
	home?: string;
	now?: () => Date;
	plannerSpawn?: PlannerSpawn;
	/** Skip the threshold check — used by the debt path + tests. */
	force?: boolean;
}): Promise<RunOutcome> {
	const env = opts.env ?? process.env;
	const home = opts.home ?? process.env.HOME ?? "";
	const now = opts.now ?? (() => new Date());
	const spawnFn = opts.plannerSpawn ?? realPlannerSpawn(env);
	const t = curatorThresholds(env);

	const factsFile = factsFilePath(env, home);
	let factsRaw: string;
	try {
		factsRaw = readFileSync(factsFile, "utf8");
	} catch {
		return { ran: false, reason: "no facts store yet" };
	}
	const facts = parseFactsFile(factsRaw);
	let lessonsRaw = "";
	try {
		lessonsRaw = readFileSync(join(home, ".pi", "agent", "lessons.md"), "utf8");
	} catch {
		/* lessons file optional */
	}
	const st = readCuratorState(env, home);
	let trigger: string;
	if (!opts.force) {
		const decision = shouldRunCurator(
			st,
			{
				factLines: nonEmptyLines(factsRaw),
				lessonLines: nonEmptyLines(lessonsRaw),
				tokensSinceRun: st.tokensSinceRun,
				sessionsSinceRun: st.sessionsSinceRun,
			},
			t,
			now(),
		);
		if (!decision.run) return { ran: false, reason: decision.reason };
		trigger = decision.reason;
	} else {
		trigger = "forced";
	}

	// Evidence pack (bounded ration; no raw transcripts, no free grep/read).
	let triggerTail = "";
	try {
		triggerTail = readFileSync(join(dirname(factsFile), "facts-trigger.log"), "utf8");
	} catch {
		/* optional */
	}
	const { pack, bytes } = buildEvidencePack({
		factsRaw,
		triggerLogTail: triggerTail,
		lessonsTail: lessonsRaw.split("\n").slice(-30).join("\n"),
	});

	// Planner with retry.
	let plannerOut: { code: number | null; stdout: string; stderr: string } | null = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const r = await spawnFn(pack, `memory-curator-${now().toISOString().replace(/[:.]/g, "-")}`);
		if (r.code === 0 && r.stdout.trim()) {
			plannerOut = r;
			break;
		}
		plannerOut = r;
		if (attempt < MAX_ATTEMPTS) await new Promise((res) => setTimeout(res, backoffMs(env)));
	}

	const runsDir = factsRunsDir(env, home);
	mkdirSync(runsDir, { recursive: true });
	const ts = now().toISOString();
	const preHash = sha256Content(factsRaw);
	const finish = (receipt: ReturnType<typeof buildReceipt>): RunOutcome => {
		const file = join(runsDir, `curator-${ts.replace(/[:.]/g, "-")}.json`);
		writeFileSync(file, JSON.stringify(receipt, null, "\t") + "\n");
		const next: CuratorState = {
			lastRunAt: ts,
			factsBaseline: nonEmptyLines(factsRaw),
			lessonsBaseline: nonEmptyLines(lessonsRaw),
			tokensSinceRun: receipt.outcome === "ok" ? 0 : st.tokensSinceRun,
			sessionsSinceRun: receipt.outcome === "ok" ? 0 : st.sessionsSinceRun,
			failingStreak: receipt.outcome === "ok" ? 0 : st.failingStreak + 1,
			lastError: receipt.outcome === "ok" ? null : (receipt.errors?.[0] ?? "unknown"),
		};
		writeCuratorState(next, env, home);
		return { ran: true, outcome: receipt.outcome, detail: receipt.errors?.join("; ") ?? receipt.outcome, receiptFile: file };
	};

	if (!plannerOut || plannerOut.code !== 0 || !plannerOut.stdout.trim()) {
		return finish(
			buildReceipt({
				trigger,
				outcome: "error",
				appliedVerdicts: 0,
				proposalsAdded: 0,
				preHash,
				postHash: preHash,
				packBytes: bytes,
				errors: [`planner failed (exit=${plannerOut?.code ?? "spawn"}): ${(plannerOut?.stderr ?? "").slice(0, 200)}`],
			}),
		);
	}

	const validation = validatePlan(plannerOut.stdout, facts, t);
	if (!validation.ok) {
		return finish(
			buildReceipt({
				trigger,
				outcome: "refused",
				appliedVerdicts: 0,
				proposalsAdded: 0,
				preHash,
				postHash: preHash,
				packBytes: bytes,
				errors: validation.errors.slice(0, 10),
			}),
		);
	}

	const applied = applyPlan(facts, validation.plan, todayIso(now));
	const nextRaw = serializeFacts(applied.facts) + "\n";
	// atomic write: temp + rename (crash mid-write keeps the old file)
	const tmp = `${factsFile}.curator-${process.pid}`;
	writeFileSync(tmp, nextRaw);
	renameSync(tmp, factsFile);

	const receipt = buildReceipt({
		trigger,
		outcome: "ok",
		appliedVerdicts: applied.tombstoned,
		proposalsAdded: applied.proposalsAdded,
		preHash,
		postHash: sha256Content(nextRaw),
		packBytes: bytes,
		planEcho: validation.plan,
	});
	const file = join(runsDir, `curator-${ts.replace(/[:.]/g, "-")}.json`);
	writeFileSync(file, JSON.stringify(receipt, null, "\t") + "\n");
	writeCuratorState(
		{
			lastRunAt: ts,
			factsBaseline: nonEmptyLines(nextRaw),
			lessonsBaseline: nonEmptyLines(lessonsRaw),
			tokensSinceRun: 0,
			sessionsSinceRun: 0,
			failingStreak: 0,
			lastError: null,
		},
		env,
		home,
	);
	return { ran: true, outcome: "ok", detail: `${applied.tombstoned} tombstoned, ${applied.proposalsAdded} proposed`, receiptFile: file };
}
