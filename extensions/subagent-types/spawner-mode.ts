/**
 * spawner-mode (#131 / plan step 14) — ai sở hữu tool spawn: extension hay
 * paseo-subagents plugin? Nguyên tắc 1 CỬA: khi plugin bật, extension KHÔNG
 * đăng ký spawn_subagent / spawn_paseo_subagent / spawn_pool (không trùng tool
 * trong context — user: "Giảm đc 1 tool subagent là giảm đc context rồi").
 *
 * settings key: subagentTypes.spawner = "extension" | "plugin" | "auto"
 * (workspace wins over user-wide, cùng merge order với mainBlockedTools).
 * auto (default) = plugin nếu ~/.paseo/config.json bật paseo-subagents.
 */

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

/** Đọc config daemon (~/.paseo/config.json) — fail-open: cấu hình lỗi coi như
 * plugin TẮT (giữ extension như trạng thái trước #131, không mất khả năng spawn). */
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
