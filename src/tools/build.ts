import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildBuildArgs, buildDestinationString, buildSimulatorDestination } from "../commands.js";
import { formatBuildResult } from "../format.js";
import { createLogger } from "../log.js";
import { parseBuildResult } from "../parsers.js";
import { formatDestinationLabel, getXcodebuildProjectArgs, resolveProjectAndScheme } from "../resolve.js";
import type { XcodeState } from "../state.js";
import { clearOperation, startOperation } from "../state.js";
import { startSpinner, stopSpinner, updateStatusBar } from "../status-bar.js";
import { createBuildExec } from "../streaming.js";
import type { ExecFn } from "../types.js";

const debug = createLogger("build");

export function registerBuildTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_build",
    label: "Xcode Build",
    description:
      "Build an Xcode project or workspace. Auto-discovers project, workspace, and scheme when not specified. Returns parsed build errors/warnings.",
    promptSnippet: "Build an Xcode project, workspace or package returning parsed errors and warnings",
    promptGuidelines: [
      "Use xcode_build to compile Xcode projects",
      "Use active project, scheme, configuration, and destination if user doesn't specify others explicitly",
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
      let destinationLabel: string | undefined;

      if (!destination && params.simulator) {
        destination = buildSimulatorDestination(params.simulator);
        destinationLabel = params.simulator;
      }
      if (!destination && state.activeDestination) {
        destination = buildDestinationString(state.activeDestination);
        destinationLabel = formatDestinationLabel(state.activeDestination);
      }

      const configuration = params.configuration ?? state.activeConfiguration ?? "Debug";

      const args = buildBuildArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: resolved.scheme,
        configuration,
        destination,
      });

      debug("full command: xcodebuild", args.join(" "));
      debug("destination:", destination, "configuration:", configuration);

      const destLabel = destinationLabel ? ` for ${destinationLabel}` : "";
      onUpdate?.({ content: [{ type: "text", text: `Building${destLabel}...` }], details: undefined });

      state.appStatus = "building";
      startSpinner(cwd, state, ctx.ui);
      const combinedSignal = startOperation(
        state,
        `Build ${resolved.scheme ?? "project"} (${configuration})${destLabel}`,
        signal,
      );

      try {
        const buildExecFn = createBuildExec(state, exec);
        const result = await buildExecFn("xcodebuild", args, {
          signal: combinedSignal,
          timeout: 600_000,
          cwd: xcodeArgs.execCwd,
        });
        debug("exit code:", result.code, "killed:", result.killed);
        const combined = `${result.stdout}\n${result.stderr}`;
        const buildResult = parseBuildResult(combined);
        debug("success:", buildResult.success, "issues:", buildResult.issues.length);

        const summary = formatBuildResult(buildResult);
        const destLine = destinationLabel ? `\nDestination: ${destinationLabel}` : "";

        return {
          content: [{ type: "text", text: summary + destLine }],
          details: {
            success: buildResult.success,
            destination: destinationLabel,
            errors: buildResult.issues.filter((i) => i.severity === "error"),
            warnings: buildResult.issues.filter((i) => i.severity === "warning"),
            command: `xcodebuild ${args.join(" ")}`,
          },
        };
      } finally {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
        updateStatusBar(cwd, state, ctx.ui);
      }
    },
  });
}
