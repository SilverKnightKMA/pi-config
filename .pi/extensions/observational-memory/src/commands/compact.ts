import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";

export function registerCompactCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:compact", {
		description: "Force an observational-memory compaction now (ignores threshold)",
		handler: async (_args: string, ctx: any) => {
			if (!runtime.enabled) {
				runtime.timeline.notify("om is off (use /om on to enable)");
				if (ctx.hasUI) ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			if (runtime.compactInFlight) {
				runtime.timeline.notify("om: compaction already in progress", "warning");
				if (ctx.hasUI) ctx.ui.notify("om: compaction already in progress", "warning");
				return;
			}
			runtime.compactInFlight = true;
			// The before-compact hook waits for in-flight observers before folding (design R5),
			// so we trigger compaction straight away here too.
			runtime.timeline.notify("om: compacting (waiting for in-flight observers)…");
			if (ctx.hasUI) ctx.ui.notify("om: compacting (waiting for in-flight observers)…", "info");
			ctx.compact({
				onComplete: () => {
					runtime.compactInFlight = false;
					runtime.timeline.notify("om: compaction complete");
					if (ctx.hasUI) ctx.ui.notify("om: compaction complete", "info");
				},
				onError: (error: { message: string }) => {
					runtime.compactInFlight = false;
					if (error.message === "Compaction cancelled") return;
					runtime.timeline.notify(`om: ${error.message}`, "error");
					if (ctx.hasUI) ctx.ui.notify(`om: ${error.message}`, "error");
				},
			});
		},
	});
}
