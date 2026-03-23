import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discover } from "../discovery.js";
import type { ExecFn } from "../types.js";

export function registerDiscoverTool(pi: ExtensionAPI, exec: ExecFn, cwd: string) {
  pi.registerTool({
    name: "xcode_discover",
    label: "Xcode Discover",
    description: "Discover Xcode projects, workspaces, schemes, and available simulators in the current directory.",
    promptSnippet: "List Xcode projects, schemes, and available simulators",
    promptGuidelines: [
      "Only call when the user explicitly asks to list or change simulators/schemes.",
      "Do NOT call before xcode_build, xcode_test, or xcode_run — they already use the selected destination.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: "Scanning for Xcode projects and simulators..." }],
        details: undefined,
      });

      const result = await discover(exec, cwd);

      const lines: string[] = [];

      // Projects
      lines.push("## Projects / Workspaces / Packages");
      if (result.projects.length === 0) {
        lines.push("  (none found)");
      } else {
        const icons: Record<string, string> = { workspace: "🗂️", project: "📁", package: "📦" };
        for (const p of result.projects) {
          lines.push(`  ${icons[p.type] ?? "📁"} ${p.path} [${p.type}]`);
        }
      }

      // Schemes
      lines.push("");
      lines.push("## Schemes");
      if (result.schemes.length === 0) {
        lines.push("  (none found)");
      } else {
        for (const s of result.schemes) {
          lines.push(`  🔧 ${s.name}  (from ${s.project})`);
        }
      }

      // Simulators (group by runtime, show only iPhones and iPads)
      lines.push("");
      lines.push("## Simulators");
      const byRuntime = new Map<string, typeof result.simulators>();
      for (const sim of result.simulators) {
        if (!sim.name.startsWith("iPhone") && !sim.name.startsWith("iPad")) continue;
        const list = byRuntime.get(sim.runtime) ?? [];
        list.push(sim);
        byRuntime.set(sim.runtime, list);
      }

      if (byRuntime.size === 0) {
        lines.push("  (none found)");
      } else {
        for (const [runtime, sims] of byRuntime) {
          lines.push(`  ${runtime}:`);
          for (const sim of sims) {
            const state = sim.state === "Booted" ? " ▶ (booted)" : "";
            lines.push(`    📱 ${sim.name}  [${sim.udid}]${state}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          projects: result.projects,
          schemes: result.schemes,
          simulatorCount: result.simulators.length,
        },
      };
    },
  });
}
