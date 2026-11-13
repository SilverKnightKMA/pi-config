/**
 * Settings-only model resolution (single source of truth = settings.json).
 *
 * Directive (user 2026-11-13): no model/provider id may be hardcoded in extension
 * source. Extensions read their model from settings.json; when the key is absent
 * they fall back to pi's own configured default model (`defaultProvider` +
 * `defaultModel` in the same file) instead of a baked-in id.
 *
 * Lookup order for a specific key: workspace `.pi/settings.json` then
 * `~/.pi/agent/settings.json` (workspace wins).
 */
import { readFileSync } from "node:fs";

export interface PiSettings {
	[key: string]: unknown;
}

function readSettingsFile(path: string): PiSettings | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return raw && typeof raw === "object" ? (raw as PiSettings) : null;
	} catch {
		return null;
	}
}

/** Read a string key from workspace .pi/settings.json > ~/.pi/agent/settings.json. */
export function readSettingsString(key: string, cwd = process.cwd()): string | null {
	const candidates = [`${cwd}/.pi/settings.json`, `${process.env.HOME || ""}/.pi/agent/settings.json`];
	for (const p of candidates) {
		const raw = readSettingsFile(p);
		const value = raw?.[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return null;
}

/**
 * pi's configured default model as a `provider/model` string, or null when the
 * settings file names neither `defaultProvider` nor `defaultModel`.
 */
export function readPiDefaultModel(cwd = process.cwd()): string | null {
	const candidates = [`${cwd}/.pi/settings.json`, `${process.env.HOME || ""}/.pi/agent/settings.json`];
	for (const p of candidates) {
		const raw = readSettingsFile(p);
		if (!raw) continue;
		const provider = typeof raw.defaultProvider === "string" ? raw.defaultProvider.trim() : "";
		const model = typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : "";
		if (!provider || !model) continue;
		return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
	}
	return null;
}
