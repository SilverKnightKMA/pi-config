import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGrepTool, createFindTool, createLsTool } from "@earendil-works/pi-coding-agent";

export default function readonlyTools(pi: ExtensionAPI) {
  pi.registerTool(createGrepTool(process.cwd()) as never);
  pi.registerTool(createFindTool(process.cwd()) as never);
  pi.registerTool(createLsTool(process.cwd()) as never);
  pi.registerCommand("readonly-dev", { description: "verify", handler: async (_a, ctx) => ctx.ui.notify("readonly OK", "info") });
}
