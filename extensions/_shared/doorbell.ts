/**
 * doorbell (#39 Phase 1) — engine→plugin bell poke.
 *
 * Doctrine: DISK IS TRUTH. The unix sockets under
 * ~/.paseo/plugin-data/bridges/ are BELLS, not a data channel — after the
 * engine writes a status/task/snip/facts file it pokes every listening
 * plugin so panels refetch through their RPC (the plugin server reads the
 * file; nothing is duplicated over the wire).
 *
 * Standalone-clean (#44/#187/#188 invariant): when the bridges dir is
 * absent (no paseo) this is a silent no-op — one readdir, zero effects.
 * pokeBridges NEVER throws and never blocks the caller: fire-and-forget
 * with a hard per-socket timeout.
 *
 * Payload contract (v1): one line of JSON, then close:
 *   {"v":1,"sessionId":"<pi session id>","kind":"<writer kind>","file":"<abs path>","ts":"<ISO>"}
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";

export const DOORBELL_VERSION = 1;

/** Default bridges dir: ~/.paseo/plugin-data/bridges (override via opts.dir for tests). */
export function bridgesDir(env: Record<string, string | undefined> = process.env): string {
	return join(env.HOME || homedir(), ".paseo", "plugin-data", "bridges");
}

export interface DoorbellPoke {
	v: typeof DOORBELL_VERSION;
	sessionId: string;
	kind: string;
	file: string;
	ts: string;
}

/** Safety cap: never iterate an absurd number of sockets from one poke. */
const MAX_SOCKETS_PER_POKE = 16;
/** Per-socket budget: a bell must never delay the writer meaningfully. */
const CONNECT_TIMEOUT_MS = 300;

function pokeOne(sockPath: string, line: string): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		try {
			const sock = createConnection({ path: sockPath });
			sock.setTimeout(CONNECT_TIMEOUT_MS);
			sock.on("connect", () => {
				try {
					sock.write(`${line}\n`);
				} catch {
					/* bell only — ignore */
				}
				sock.destroy();
				done();
			});
			sock.on("timeout", () => {
				sock.destroy();
				done();
			});
			sock.on("error", () => {
				/* dead/stale socket — normal, skip silently */
				done();
			});
		} catch {
			done();
		}
	});
}

/**
 * Poke every plugin bridge socket with one bell line. Fire-and-forget:
 * returns a promise (all pokes settled) but callers normally ignore it —
 * `void pokeBridges(...)`. NEVER throws; missing dir = instant no-op.
 */
export async function pokeBridges(
	kind: string,
	file: string,
	sessionId: string,
	opts: { dir?: string } = {},
): Promise<void> {
	try {
		const dir = opts.dir ?? bridgesDir();
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return; // standalone pi — no bridges dir, clean no-op
		}
		const line = JSON.stringify({
			v: DOORBELL_VERSION,
			sessionId,
			kind,
			file,
			ts: new Date().toISOString(),
		} satisfies DoorbellPoke);
		const sockets = entries.filter((e) => e.endsWith(".sock")).slice(0, MAX_SOCKETS_PER_POKE);
		await Promise.all(sockets.map((e) => pokeOne(join(dir, e), line)));
	} catch {
		/* a bell must never break the writer */
	}
}
