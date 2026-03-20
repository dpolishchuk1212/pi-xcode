import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import type { XcodeState } from "../state.js";
import { buildBuildArgs, buildSimulatorDestination } from "../commands.js";
import { parseBuildResult } from "../parsers.js";
import { discoverSimulators, findSimulator } from "../discovery.js";
import { resolveProjectAndScheme, getXcodebuildProjectArgs } from "../resolve.js";
import { formatBuildResult } from "../format.js";

export function registerBuildTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
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

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Discovering project..." }], details: undefined });

      // ── Resolve project and scheme ───────────────────────────────────
      const resolved = await resolveProjectAndScheme(exec, cwd, state, ctx.ui, {
        project: params.project,
        workspace: params.workspace,
        scheme: params.scheme,
      });

      const xcodeArgs = getXcodebuildProjectArgs(resolved.project);

      // ── Resolve destination ──────────────────────────────────────────
      let destination = params.destination;
      let simulatorName: string | undefined;

      if (!destination && params.simulator) {
        destination = buildSimulatorDestination(params.simulator);
        simulatorName = params.simulator;
      }
      if (!destination && state.activeSimulator) {
        destination = buildSimulatorDestination(state.activeSimulator.udid);
        simulatorName = `${state.activeSimulator.name} (${state.activeSimulator.runtime})`;
      }
      if (!destination) {
        const simulators = await discoverSimulators(exec);
        const sim = findSimulator(simulators);
        if (sim) {
          destination = buildSimulatorDestination(sim.udid);
          simulatorName = `${sim.name} (${sim.runtime})`;
        }
      }

      const args = buildBuildArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: resolved.scheme,
        configuration: params.configuration ?? "Debug",
        destination,
      });

      const simLabel = simulatorName ? ` for ${simulatorName}` : "";
      onUpdate?.({ content: [{ type: "text", text: `Building${simLabel}...` }], details: undefined });

      const result = await exec("xcodebuild", args, { signal, timeout: 600_000, cwd: xcodeArgs.execCwd });
      const combined = result.stdout + "\n" + result.stderr;
      const buildResult = parseBuildResult(combined);

      const summary = formatBuildResult(buildResult);
      const simulatorLine = simulatorName ? `\nSimulator: ${simulatorName}` : "";

      return {
        content: [{ type: "text", text: summary + simulatorLine }],
        details: {
          success: buildResult.success,
          simulator: simulatorName,
          errors: buildResult.issues.filter((i) => i.severity === "error"),
          warnings: buildResult.issues.filter((i) => i.severity === "warning"),
          command: `xcodebuild ${args.join(" ")}`,
        },
      };
    },
  });
}
