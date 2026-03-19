import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import { buildCleanArgs } from "../commands.js";
import { discover, autoSelect } from "../discovery.js";

export function registerCleanTool(pi: ExtensionAPI, exec: ExecFn, cwd: string) {
  pi.registerTool({
    name: "xcode_clean",
    label: "Xcode Clean",
    description: "Clean build artifacts for an Xcode project or workspace.",
    promptSnippet: "Clean Xcode build artifacts",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Path to .xcodeproj" })),
      workspace: Type.Optional(Type.String({ description: "Path to .xcworkspace" })),
      scheme: Type.Optional(Type.String({ description: "Build scheme (auto-discovered if omitted)" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      let projectArg = params.workspace ?? params.project;
      let schemeArg = params.scheme;

      if (!projectArg || !schemeArg) {
        const discovery = await discover(exec, cwd);
        const selected = autoSelect(discovery, schemeArg);
        if (!projectArg && selected.project) projectArg = selected.project.path;
        if (!schemeArg && selected.scheme) schemeArg = selected.scheme.name;
      }

      if (!projectArg) {
        throw new Error("No Xcode project or workspace found. Specify one explicitly.");
      }

      const args = buildCleanArgs({
        project: params.workspace ? undefined : projectArg,
        workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
        scheme: schemeArg,
      });

      onUpdate?.({ content: [{ type: "text", text: `Cleaning: xcodebuild ${args.join(" ")}` }] });

      const result = await exec("xcodebuild", args, { signal, timeout: 120_000 });
      const success = result.code === 0;

      return {
        content: [
          {
            type: "text",
            text: success ? "✅ Clean succeeded." : `❌ Clean failed.\n${result.stderr}`,
          },
        ],
        details: { success, command: `xcodebuild ${args.join(" ")}` },
      };
    },
  });
}
