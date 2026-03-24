import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildBuildArgs, buildDestinationString, buildSimulatorDestination } from "../commands.js";
import { formatBuildResult } from "../format.js";
import { createLogger } from "../log.js";
import { parseBuildResult } from "../parsers.js";
import { formatDestinationLabel, getXcodebuildProjectArgs } from "../resolve.js";
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
      "Build the active Xcode project. Uses the active project, scheme, configuration, and destination. Returns parsed build errors/warnings.",
    promptSnippet: "Build the active Xcode project returning parsed errors and warnings",
    promptGuidelines: [
      "Use xcode_build to compile the active Xcode project.",
      "Destination and configuration can be overridden — only do so if the user explicitly asks.",
    ],
    parameters: Type.Object({
      configuration: Type.Optional(Type.String({ description: "Debug or Release (default: active configuration)" })),
      destination: Type.Optional(
        Type.String({ description: "Build destination. Only pass if user explicitly requests a different destination." }),
      ),
      simulator: Type.Optional(Type.String({ description: "Simulator name or UDID. Only pass if user explicitly requests a different simulator." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // ── Validate active state ────────────────────────────────────────
      if (!state.activeProject || !state.activeScheme) {
        throw new Error("No active project or scheme. Use /project and /scheme to select one.");
      }

      debug("active project:", state.activeProject.path, "scheme:", state.activeScheme.name);

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);

      // ── Resolve destination ──────────────────────────────────────────
      // Priority: explicit destination > explicit simulator > active destination
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
        scheme: state.activeScheme.name,
        configuration,
        destination,
      });

      debug("full command: xcodebuild", args.join(" "));
      debug("destination:", destination, "configuration:", configuration);

      const destLabel = destinationLabel ? ` for ${destinationLabel}` : "";
      onUpdate?.({ content: [{ type: "text", text: `Building ${state.activeScheme.name} (${configuration})${destLabel}...` }], details: undefined });

      state.appStatus = "building";
      startSpinner(cwd, state, ctx.ui);
      const combinedSignal = startOperation(
        state,
        `Build ${state.activeScheme.name} (${configuration})${destLabel}`,
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
