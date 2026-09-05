/**
 * Workspace-level OM status snapshot for live UI surfaces (Paseo om-status
 * plugin panel). Written by the timeline sink on every OM lifecycle event —
 * v2 (2026-09-04): OM events no longer enter the model context as custom
 * messages; the file is the display channel, the panel polls it.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Runtime } from "../runtime.js";
import { buildStatusLines } from "../commands/status.js";

export interface OmStatusEvent {
	ts: string;
	text: string;
}

export interface OmStatusFile {
	schema: 1;
	generatedAt: string;
	enabled: boolean;
	sessionId: string;
	workspace: string;
	/** /om status output lines (same numbers the command shows). */
	lines: string[];
	/** Ring of recent lifecycle events, newest last. */
	events: OmStatusEvent[];
}

const RING_LIMIT = 24;

export function omStatusPath(runtime: Runtime): string | null {
	if (!runtime.memoryRoot) return null;
	// memoryRoot = <cwd>/.memory/<sessionId> -> status lives at <cwd>/.memory/om-status.json
	// one dirname only: memoryRoot is <cwd>/.memory/<sessionId>, the status file
	// is workspace-level -> <cwd>/.memory/om-status.json (what the om-status
	// Paseo plugin reads). Two dirnames would drop it in the workspace root.
	return join(dirname(runtime.memoryRoot), "om-status.json");
}

async function readRing(path: string): Promise<OmStatusEvent[]> {
	try {
		const prior = JSON.parse(await readFile(path, "utf8")) as { events?: unknown };
		return Array.isArray(prior.events) ? (prior.events as OmStatusEvent[]) : [];
	} catch {
		return [];
	}
}

/** Append a lifecycle event to the ring and rewrite the snapshot. Fire-and-forget safe. */
export async function appendOmStatusEvent(runtime: Runtime, text: string): Promise<void> {
	const path = omStatusPath(runtime);
	if (!path) return; // OM off for this session — nothing to show
	try {
		const events = await readRing(path);
		events.push({ ts: new Date().toISOString(), text });
		while (events.length > RING_LIMIT) events.shift();
		const snapshot: OmStatusFile = {
			schema: 1,
			generatedAt: new Date().toISOString(),
			enabled: runtime.enabled,
			sessionId: runtime.memoryRoot ? runtime.memoryRoot.split("/").pop() ?? "" : "",
			workspace: dirname(dirname(runtime.memoryRoot)),
			lines: buildStatusLines(runtime, [], null),
			events,
		};
		const tmp = `${path}.tmp-${process.pid}`;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
		await rename(tmp, path);
	} catch {
		// The status file is display-only: never let a write failure
		// disturb the pipeline. Next event retries.
	}
}
