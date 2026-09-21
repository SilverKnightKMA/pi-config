/**
 * spawner-mode (#131 / plan step 14) — which component owns the spawn tool:
 * the extension or the paseo-subagents plugin? ONE DOOR rule: when the plugin
 * is enabled, the extension does NOT register spawn_subagent /
 * spawn_paseo_subagent / spawn_pool (no duplicate tools in context — user:
 * "Removing one subagent tool already reduces the context size").
 *
 * settings key: subagentTypes.spawner = "extension" | "plugin" | "auto"
 * (workspace wins over user-wide, using the same merge order as mainBlockedTools).
 * auto (default) = plugin when ~/.paseo/config.json enables paseo-subagents.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type SpawnerMode = "extension" | "plugin" | "auto";
export type EffectiveSpawner = "extension" | "plugin";

export const SPAWNER_PLUGIN_ID = "paseo-subagents";

export function readSpawnerMode(
	wsCfg: Record<string, unknown> | null,
	userCfg: Record<string, unknown> | null,
): SpawnerMode {
	for (const cfg of [wsCfg, userCfg]) {
		if (!cfg) continue;
		const sub = cfg.subagentTypes;
		if (typeof sub !== "object" || sub === null) continue;
		const raw = (sub as Record<string, unknown>).spawner;
		if (raw === "extension" || raw === "plugin" || raw === "auto") return raw;
	}
	return "auto";
}

/** Read daemon config (~/.paseo/config.json) — fail-open: invalid config treats
 * the plugin as DISABLED (keeps the extension in its pre-#131 state so spawning remains available). */
export function isPluginEnabled(configJson: unknown): boolean {
	if (typeof configJson !== "object" || configJson === null) return false;
	const plugins = (configJson as Record<string, unknown>).plugins;
	if (typeof plugins !== "object" || plugins === null) return false;
	const entry = (plugins as Record<string, unknown>)[SPAWNER_PLUGIN_ID];
	if (typeof entry !== "object" || entry === null) return false;
	return (entry as Record<string, unknown>).enabled === true;
}

export function effectiveSpawner(mode: SpawnerMode, pluginEnabled: boolean): EffectiveSpawner {
	if (mode === "extension") return "extension";
	if (mode === "plugin") return "plugin";
	return pluginEnabled ? "plugin" : "extension";
}

/** #187 standalone-clean (#44 regression after the one-door port): is there ANY
 * sign of a paseo daemon on this machine — ~/.paseo/config.json exists or any
 * PASEO_* env var is set? When false, BOTH createChildAgent paths (CLI carrier
 * spawnViaCli + MCP createAgent) cannot reach a daemon, so registering spawn
 * tools would surface them as registered-but-dead. Children spawned BY paseo
 * always carry PASEO_* env, so they never hit the gate. */
export function paseoPresent(home: string, env: Record<string, string | undefined> = process.env): boolean {
	if (existsSync(join(home, ".paseo", "config.json"))) return true;
	return Object.keys(env).some((k) => k.startsWith("PASEO_"));
}

/** #187: one decision point for whether the extension registers its spawn
 * tools. extOwnsSpawn now ALSO requires a paseo daemon hint — absent daemon
 * means the tools are hidden (standalone pi stays clean) instead of dead. */
export function resolveExtOwnsSpawn(
	mode: SpawnerMode,
	pluginEnabled: boolean,
	paseoHere: boolean,
): { spawner: EffectiveSpawner; extOwnsSpawn: boolean } {
	const spawner = effectiveSpawner(mode, pluginEnabled);
	return { spawner, extOwnsSpawn: spawner === "extension" && paseoHere };
}
