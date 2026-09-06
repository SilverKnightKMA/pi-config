/**
 * read-only mode for pi — daemon port of amosblomqvist/pi-config
 * zz-read-only-mode.ts (2026-08-25 snapshot).
 *
 * Usage (works as a pi slash command in Paseo):
 *   /read-only        -> toggle
 *   /read-only on     -> enable
 *   /read-only off    -> disable
 *   /read-only status -> show current state
 *
 * Mechanism (all daemon-compatible APIs, verified on pi 0.84.4):
 * - Hard-enforces a tiny tool allowlist: read, grep, find, ls
 * - pi.setActiveTools() restricts the active tool set
 * - tool_call hook blocks anything outside the allowlist with a reason
 * - before_agent_start injects a system-prompt note while enabled
 *
 * Deliberate divergences from upstream (2026-09-06 port):
 * - import scope @earendil-works (our pi package) instead of @mariozechner
 * - TUI status-row/widget updates removed (ctx.ui.setStatus/setWidget have no
 *   surface in the headless daemon; notify kept — harmless)
 * - State is in-memory only and resets when pi restarts (upstream behavior)
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";

export const COMMAND_NAME = "read-only";
export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

export function getReadOnlyToolNames(pi: ExtensionAPI): string[] {
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	return READ_ONLY_TOOL_NAMES.filter((name) => allToolNames.has(name));
}

function applyReadOnlyTools(pi: ExtensionAPI): void {
	pi.setActiveTools(getReadOnlyToolNames(pi));
}

export function restoreTools(pi: ExtensionAPI, toolsBeforeReadOnly?: string[]): string[] {
	const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	const toolNames = (toolsBeforeReadOnly ?? pi.getAllTools().map((tool) => tool.name)).filter((toolName) =>
		allToolNames.has(toolName),
	);
	pi.setActiveTools(toolNames);
	return toolNames;
}

export default function readOnlyModeExtension(pi: ExtensionAPI) {
	let enabled = false;
	let toolsBeforeReadOnly: string[] | undefined;

	// Re-register the read-only tools so cwd follows the per-call ctx.cwd
	// instead of the process cwd (faithful to upstream).
	const readTool = createReadTool(process.cwd());
	pi.registerTool({
		...readTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
	});

	const grepTool = createGrepTool(process.cwd());
	pi.registerTool({
		...grepTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createGrepTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
	});

	const findTool = createFindTool(process.cwd());
	pi.registerTool({
		...findTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createFindTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
	});

	const lsTool = createLsTool(process.cwd());
	pi.registerTool({
		...lsTool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createLsTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
	});

	function enableReadOnlyMode(ctx: ExtensionContext): void {
		if (enabled) {
			ctx.ui.notify("Read-only mode is already enabled.", "info");
			return;
		}

		enabled = true;
		toolsBeforeReadOnly = pi.getActiveTools();
		applyReadOnlyTools(pi);

		const tools = getReadOnlyToolNames(pi).join(", ");
		ctx.ui.notify(`Read-only mode enabled. Tools: ${tools || "(none)"}.`, "info");
	}

	function disableReadOnlyMode(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.notify("Read-only mode is already disabled.", "info");
			return;
		}

		enabled = false;
		restoreTools(pi, toolsBeforeReadOnly);
		toolsBeforeReadOnly = undefined;
		ctx.ui.notify("Read-only mode disabled. Previous tool access restored.", "info");
	}

	function toggleReadOnlyMode(ctx: ExtensionContext): void {
		if (enabled) disableReadOnlyMode(ctx);
		else enableReadOnlyMode(ctx);
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Toggle hard-enforced read-only mode (allowlist: read, grep, find, ls)",
		getArgumentCompletions(prefix) {
			const actions = ["toggle", "on", "off", "status"];
			const items = actions
				.filter((action) => action.startsWith(prefix.toLowerCase()))
				.map((action) => ({ value: action, label: action }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			switch (action) {
				case "":
				case "toggle":
					toggleReadOnlyMode(ctx);
					return;
				case "on":
				case "enable":
					enableReadOnlyMode(ctx);
					return;
				case "off":
				case "disable":
					disableReadOnlyMode(ctx);
					return;
				case "status": {
					const tools = getReadOnlyToolNames(pi).join(", ");
					ctx.ui.notify(
						enabled
							? `Read-only mode is ON. Allowed tools: ${tools || "(none)"}.`
							: "Read-only mode is OFF.",
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(`Usage: /${COMMAND_NAME} [on|off|toggle|status]`, "warning");
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled) return;

		applyReadOnlyTools(pi);

		const tools = getReadOnlyToolNames(pi).join(", ") || "(none)";
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[Read-only mode is active]\n` +
				`- You may only use these tools: ${tools}.\n` +
				`- You must not attempt any action that changes local files, processes, git state, dependencies, databases, remote systems, or any other external state.\n` +
				`- If the user asks for any write or side-effecting action, explain that read-only mode is enabled and tell them to run /${COMMAND_NAME} off first.`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!enabled) return;

		const allowedToolNames = new Set(getReadOnlyToolNames(pi));
		if (allowedToolNames.has(event.toolName)) return;

		return {
			block: true,
			reason:
				`Read-only mode is active. Tool "${event.toolName}" is blocked. ` +
				`Allowed tools: ${Array.from(allowedToolNames).join(", ") || "(none)"}. ` +
				`Use /${COMMAND_NAME} off to restore full tool access.`,
		};
	});

	pi.on("session_start", async () => {
		if (enabled) applyReadOnlyTools(pi);
	});

	pi.on("session_switch", async () => {
		if (enabled) applyReadOnlyTools(pi);
	});

	pi.on("session_fork", async () => {
		if (enabled) applyReadOnlyTools(pi);
	});
}
