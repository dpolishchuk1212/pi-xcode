import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildBuildArgs, buildDestinationString } from "../commands.js";
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
      "Always uses the active project, scheme, configuration, and destination. Use /project, /scheme, /destination, /configuration commands to change them.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      // ── Validate active state ────────────────────────────────────────
      if (!state.activeProject || !state.activeScheme) {
        throw new Error("No active project or scheme. Use /project and /scheme to select one.");
      }

      debug("active project:", state.activeProject.path, "scheme:", state.activeScheme.name);

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);

      // ── Resolve destination from active state ────────────────────────
      let destination: string | undefined;
      let destinationLabel: string | undefined;

      if (state.activeDestination) {
        destination = buildDestinationString(state.activeDestination);
        destinationLabel = formatDestinationLabel(state.activeDestination);
      }

      const configuration = state.activeConfiguration ?? "Debug";

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
      onUpdate?.({
        content: [{ type: "text", text: `Building ${state.activeScheme.name} (${configuration})${destLabel}...` }],
        details: undefined,
      });

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

        // Check for cancellation before parsing
        if (result.killed || combinedSignal.aborted) {
          debug("build cancelled (killed=%s, aborted=%s)", result.killed, combinedSignal.aborted);
          throw new Error("Build cancelled by user.");
        }

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
