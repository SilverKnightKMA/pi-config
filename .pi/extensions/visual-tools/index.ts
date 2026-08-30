/**
 * visual-tools
 *
 * A self-contained pi extension that registers six visual authoring tools
 * directly in whatever pi process loads it (main session AND subagents whose
 * role frontmatter lists them):
 *
 *   • write_mermaid / edit_mermaid / render_mermaid
 *       (tools/mermaid_tools.ts) — the mermaid-maker's authoring loop: write a
 *       Mermaid source, exact-match edit it, render whatever is currently in
 *       the managed file to a PNG (via the bundled @mermaid-js/mermaid-cli and
 *       an installed Chrome), return the PNG inline for inspection, and — when
 *       given `save_as` — publish it into <cwd>/viz with a unique name.
 *   • write_svg / edit_svg / render_svg
 *       (tools/svg_tools.ts) — the svg-maker's authoring loop: same shape, but
 *       renders hand-written SVG to a PNG via rsvg-convert (fallback: magick).
 *
 * ── How the tools reach subagents here ─────────────────────────────────────
 * In this workspace subagents are spawned by `subagent-types` (Paseo port of
 * amosblomqvist/pi-subagents), NOT by interactive-subagents: the child's pi
 * process loads this project-local extension directory the same way the main
 * session does, so the tool factories below simply run there. The upstream
 * interactive-subagents bridge (`globalThis.__pi_interactive_subagents`)
 * does not exist in this workspace and is not used.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import mermaidToolsExtension from "./tools/mermaid_tools.ts"
import svgToolsExtension from "./tools/svg_tools.ts"

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url))
const MERMAID_TOOLS = path.join(EXT_DIR, "tools", "mermaid_tools.ts")
const SVG_TOOLS = path.join(EXT_DIR, "tools", "svg_tools.ts")

export default function (pi: ExtensionAPI) {
  // Direct registration: when interactive-subagents is absent (e.g. running
  // headless under Paseo), register the tool factories ourselves so the six
  // tools are available to the main session.
  try {
    if (fs.existsSync(MERMAID_TOOLS)) mermaidToolsExtension(pi)
    if (fs.existsSync(SVG_TOOLS)) svgToolsExtension(pi)
  } catch (err) {
    // Tool factories throwing should not break extension load.
  }

}
