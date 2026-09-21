/**
 * doorbell-server (#39 Phase 2) — engine-side per-session bell socket.
 *
 * DISK IS TRUTH: plugins WRITE control files (task-control, snip-control,
 * facts-control, plan-control) and then poke this socket so the engine
 * applies them in ms instead of waiting on fs.watch (which stays as a
 * backstop for non-paseo writers).
 *
 * Architecture (plan 2026-09-22, approved): ONE unix socket per pi session
 * at ~/.pi/agent/bridges/<sessionId>.sock (mode 0600, stale cleanup on
 * start) + a process-wide dispatcher: consumers register listeners by bell
 * kind at activate; the socket starts when the session id is known and
 * stops at shutdown. Several extensions share one pi process — they all
 * ride the SAME session socket through the dispatcher.
 *
 * Standalone-clean (#44/#187/#188): plain `pi` without paseo still owns
 * ~/.pi — the socket opens, nobody pokes it, zero cost. NEVER throws.
 */

import { createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DoorbellBell {
	v: 1;
	sessionId: string;
	kind: string;
	file: string;
	ts: string;
}

export interface DoorbellServerOpts {
	/** Bridges dir override (tests). Default ~/.pi/agent/bridges. */
	dir?: string;
	log?: (msg: string) => void;
}

type BellHandler = (bell: DoorbellBell) => void;

/** Process-wide dispatcher state (one pi process = one session socket). */
const listeners = new Map<string, Set<BellHandler>>();
let server: Server | null = null;
let sockPath = "";

/** Register a handler for bell kinds. Returns a disposer. Never throws. */
export function registerBellListener(kinds: readonly string[], handler: BellHandler): () => void {
	for (const kind of kinds) {
		let set = listeners.get(kind);
		if (!set) {
			set = new Set();
			listeners.set(kind, set);
		}
		set.add(handler);
	}
	return () => {
		for (const kind of kinds) listeners.get(kind)?.delete(handler);
	};
}

/** Dispatch one validated bell to registered handlers (exported for tests). */
export function dispatchBell(bell: DoorbellBell): void {
	for (const handler of listeners.get(bell.kind) ?? []) {
		try {
			handler(bell);
		} catch {
			// one bad handler must not starve the others
		}
	}
}

function bridgesRoot(opts?: DoorbellServerOpts): string {
	return opts?.dir ?? join(homedir(), ".pi", "agent", "bridges");
}

/**
 * Open the per-session bell socket. Idempotent: if already listening on a
 * path for this session it is a no-op. Returns the stop function (also
 * idempotent-safe). Null when the socket could not be opened — callers
 * keep their fs.watch path either way.
 */
export function startDoorbellServer(sessionId: string, opts: DoorbellServerOpts = {}): (() => void) | null {
	if (!sessionId) return null;
	if (server) return () => stopDoorbellServer(); // already up (first starter wins)
	const log = opts.log ?? (() => {});
	try {
		const dir = bridgesRoot(opts);
		sockPath = join(dir, `${sessionId}.sock`);
		mkdirSync(dir, { recursive: true });
		try {
			unlinkSync(sockPath); // stale socket from a previous run
		} catch {
			// not there — fine
		}
		const s = createServer((conn) => {
			let buf = "";
			conn.on("data", (d) => {
				buf += d.toString("utf8");
			});
			conn.on("close", () => {
				for (const l of buf.split("\n")) {
					const line = l.trim();
					if (!line) continue;
					try {
						const poke = JSON.parse(line) as DoorbellBell;
						if (poke?.v === 1 && typeof poke.kind === "string" && typeof poke.sessionId === "string") {
							dispatchBell({ v: 1, sessionId: poke.sessionId, kind: poke.kind, file: poke.file ?? "", ts: poke.ts ?? "" });
						}
					} catch {
						// malformed bell — ignore
					}
				}
			});
			conn.on("error", () => {
				/* bell only — ignore */
			});
		});
		s.on("error", (err) => {
			// a bell must never break the engine: log and disable
			log(`doorbell-server: socket error: ${String(err)}`);
			server = null;
		});
		s.listen(sockPath, () => {
			try {
				chmodSync(sockPath, 0o600); // engine-owned dir; same-user daemons only
			} catch {
				// best effort
			}
			log(`doorbell-server: listening ${sockPath}`);
		});
		server = s;
		return () => stopDoorbellServer();
	} catch (err) {
		log(`doorbell-server: unavailable (${String(err)}) — fs.watch fallback`);
		server = null;
		return null;
	}
}

export function stopDoorbellServer(): void {
	const s = server;
	server = null;
	if (!s) return;
	try {
		s.close();
	} catch {
		/* already closed */
	}
	try {
		rmSync(sockPath, { force: true });
	} catch {
		// best effort
	}
}
