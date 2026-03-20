import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import type { XcodeState } from "../state.js";
import { buildBuildArgs, buildSimulatorDestination } from "../commands.js";
import { parseBuildResult } from "../parsers.js";
import { discover, autoSelect, discoverProjects, discoverSchemes, findSimulator, discoverSimulators } from "../discovery.js";
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

        // Nothing found at top level — search subdirectories and ask the user
        if (!projectArg) {
          onUpdate?.({ content: [{ type: "text", text: "No project in current directory, searching subdirectories..." }], details: undefined });
          const deepProjects = await discoverProjects(exec, cwd, 4);

          if (deepProjects.length === 0) {
            throw new Error("No Xcode project or workspace found in current directory or subdirectories.");
          }

          if (deepProjects.length === 1) {
            projectArg = deepProjects[0].path;
          } else {
            // Ask the user to pick
            const options = deepProjects.map((p) => p.path);

            const choice = await ctx.ui.select("Multiple Xcode projects found. Which one to build?", options);
            if (choice === undefined) {
              throw new Error("Build cancelled — no project selected.");
            }

            projectArg = choice;
          }

          // Discover schemes for the selected project
          const schemes = await discoverSchemes(exec, projectArg!);
          if (schemes.length > 0) {
            const mainScheme = schemes.find((s) => !s.name.toLowerCase().includes("test")) ?? schemes[0];
            schemeArg = mainScheme.name;
          }
        }
      }

      if (!projectArg) {
        throw new Error("No Xcode project or workspace found. Specify one explicitly.");
      }

      // Resolve destination: explicit param > active simulator > auto-detect
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
        project: params.workspace ? undefined : projectArg,
        workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
        scheme: schemeArg,
        configuration: params.configuration ?? "Debug",
        destination,
      });

      const simLabel = simulatorName ? ` for ${simulatorName}` : "";
      onUpdate?.({ content: [{ type: "text", text: `Building${simLabel}...` }], details: undefined });

      const result = await exec("xcodebuild", args, { signal, timeout: 600_000 });
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
