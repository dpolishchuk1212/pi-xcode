import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import { buildBuildArgs, buildSimulatorDestination } from "../commands.js";
import { parseBuildResult } from "../parsers.js";
import { discover, autoSelect } from "../discovery.js";
import { formatBuildResult } from "../format.js";

export function registerBuildTool(pi: ExtensionAPI, exec: ExecFn, cwd: string) {
  pi.registerTool({
    name: "xcode_build",
    label: "Xcode Build",
    description:
      "Build an Xcode project or workspace. Auto-discovers project, workspace, and scheme when not specified. Returns parsed build errors/warnings.",
    promptSnippet: "Build an Xcode project or workspace, returning parsed errors and warnings",
    promptGuidelines: [
      "Use xcode_build to compile Xcode projects. Omit project/workspace/scheme to auto-discover them.",
      "Specify configuration as 'Debug' or 'Release'. Default is 'Debug'.",
    ],
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Path to .xcodeproj" })),
      workspace: Type.Optional(Type.String({ description: "Path to .xcworkspace" })),
      scheme: Type.Optional(Type.String({ description: "Build scheme (auto-discovered if omitted)" })),
      configuration: Type.Optional(Type.String({ description: "Debug or Release (default: Debug)" })),
      destination: Type.Optional(
        Type.String({ description: "Build destination, e.g. 'platform=iOS Simulator,name=iPhone 16'" }),
      ),
      simulator: Type.Optional(Type.String({ description: "Simulator name or UDID (builds for this simulator)" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Discovering project..." }] });

      // Auto-discover if not specified
      let projectArg = params.workspace ?? params.project;
      let schemeArg = params.scheme;

      if (!projectArg || !schemeArg) {
        const discovery = await discover(exec, cwd);
        const selected = autoSelect(discovery, schemeArg);

        if (!projectArg && selected.project) {
          projectArg = selected.project.path;
        }
        if (!schemeArg && selected.scheme) {
          schemeArg = selected.scheme.name;
        }
      }

      if (!projectArg) {
        throw new Error("No Xcode project or workspace found in current directory. Specify one explicitly.");
      }

      // Resolve destination
      let destination = params.destination;
      if (!destination && params.simulator) {
        destination = buildSimulatorDestination(params.simulator);
      }

      const args = buildBuildArgs({
        project: params.workspace ? undefined : projectArg,
        workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
        scheme: schemeArg,
        configuration: params.configuration ?? "Debug",
        destination,
      });

      onUpdate?.({ content: [{ type: "text", text: `Building: xcodebuild ${args.join(" ")}` }] });

      const result = await exec("xcodebuild", args, { signal, timeout: 600_000 });
      const combined = result.stdout + "\n" + result.stderr;
      const buildResult = parseBuildResult(combined);

      return {
        content: [{ type: "text", text: formatBuildResult(buildResult) }],
        details: {
          success: buildResult.success,
          errors: buildResult.issues.filter((i) => i.severity === "error"),
          warnings: buildResult.issues.filter((i) => i.severity === "warning"),
          command: `xcodebuild ${args.join(" ")}`,
        },
      };
    },
  });
}
