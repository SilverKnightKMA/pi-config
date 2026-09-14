/**
 * v1.4.56 one-time migration: flatten nested topic files into the session memory root.
 *
 * Live incident 2026-09-14 16:35: the v1.4.54 consolidator wrote `goal-extension.md` into a
 * nested `<root>/<sessionId>/` directory (the legacy toolset allowed subdir writes; the model
 * resolved a relative path one level too deep). `listTopics`/INDEX only scan the root level,
 * so the file vanished from the memory map. This migration moves every nested `*.md` (depth ≥ 2)
 * up to the root, removes emptied directories, and re-renders INDEX.md. Marker-guarded: at most
 * once per memory root; failures are skipped per-file, never thrown into the caller.
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, indexPath, listTopics } from "./paths.js";
import { renderIndexFile } from "./index-render.js";

export const MIGRATION_MARKER = ".migration-v1456-done";

export type MigrationResult = { ran: boolean; moved: string[]; skipped: string[]; removedDirs: string[] };

/** Collect every *.md at depth ≥ 2 (dot-entries like .runs and the marker are skipped). */
export function listNestedMdFiles(root: string): { abs: string; rel: string }[] {
	const out: { abs: string; rel: string }[] = [];
	const walk = (dir: string, rel: string): void => {
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".")) continue;
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(full, rel === "" ? name : `${rel}/${name}`);
			} else if (name.endsWith(".md") && rel !== "") {
				out.push({ abs: full, rel: `${rel}/${name}` });
			}
		}
	};
	walk(root, "");
	return out;
}

/** Delete directories that became empty (non-dot only); returns the removed top names. */
function removeEmptyDirs(root: string): string[] {
	const removed: string[] = [];
	const walk = (dir: string): boolean => {
		let empty = true;
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".")) {
				empty = false;
				continue;
			}
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				empty = false;
				continue;
			}
			if (st.isDirectory()) {
				if (walk(full)) {
					try {
						rmSync(full, { recursive: true, force: true });
						removed.push(name);
					} catch {
						empty = false;
					}
				} else {
					empty = false;
				}
			} else {
				empty = false;
			}
		}
		return empty;
	};
	walk(root);
	return removed;
}

/** Flatten nested topic files up to the root, drop emptied dirs, re-render INDEX. Marker-guarded. */
export function migrateNestedTopics(root: string): MigrationResult {
	const result: MigrationResult = { ran: false, moved: [], skipped: [], removedDirs: [] };
	if (!existsSync(root)) return result;
	if (existsSync(join(root, MIGRATION_MARKER))) return result;
	result.ran = true;

	for (const file of listNestedMdFiles(root)) {
		const basename = file.rel.split("/").pop() as string;
		if (/^index\.md$/i.test(basename) || /^journey\.md$/i.test(basename)) {
			result.skipped.push(`${file.rel} (reserved name; left in place)`);
			continue;
		}
		const target = join(root, basename);
		if (existsSync(target)) {
			result.skipped.push(`${file.rel} (name collision at root)`);
			continue;
		}
		try {
			renameSync(file.abs, target);
			result.moved.push(file.rel);
		} catch {
			result.skipped.push(`${file.rel} (move failed)`);
		}
	}

	result.removedDirs = removeEmptyDirs(root);

	try {
		atomicWrite(indexPath(root), renderIndexFile(listTopics(root)));
	} catch {
		/* best-effort: the next consolidator run re-renders INDEX anyway */
	}
	try {
		writeFileSync(join(root, MIGRATION_MARKER), new Date().toISOString(), "utf-8");
	} catch {
		/* a missing marker only means a harmless idempotent re-scan */
	}
	return result;
}
