import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildCleanArgs } from "../commands.js";
import { createLogger } from "../log.js";
import { getXcodebuildProjectArgs } from "../resolve.js";
import type { XcodeState } from "../state.js";
import { clearOperation, startOperation } from "../state.js";
import { startSpinner, stopSpinner, updateStatusBar } from "../status-bar.js";
import type { ExecFn } from "../types.js";
import { stopActiveOperation } from "./stop.js";

const debug = createLogger("clean");

export function registerCleanTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_clean",
    label: "Xcode Clean",
    description: "Clean build artifacts for the active Xcode project or workspace.",
    promptSnippet: "Clean Xcode build artifacts for the active project",
    promptGuidelines: [
      "Use xcode_clean to remove build artifacts for the active project. Takes no parameters.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      // ── Validate active state ────────────────────────────────────────
      if (!state.activeProject) {
        throw new Error("No active project. Use /project to select one.");
      }

      debug("active project:", state.activeProject.path, "type:", state.activeProject.type, "scheme:", state.activeScheme?.name);

      // ── Stop any active operation first ──────────────────────────────
      if (state.appStatus !== "idle") {
        debug("stopping active operation before clean, status:", state.appStatus);
        await stopActiveOperation(exec, cwd, state, ctx.ui);
      }

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);

      // For Package.swift, use `swift package clean` which is more idiomatic
      if (state.activeProject.type === "package") {
        state.appStatus = "cleaning";
        startSpinner(cwd, state, ctx.ui);
        const combinedSignal = startOperation(state, "Clean package", signal);
        try {
          debug("cleaning package at:", xcodeArgs.execCwd);
          onUpdate?.({ content: [{ type: "text", text: "Cleaning package..." }], details: undefined });
          const result = await exec("swift", ["package", "clean"], {
            signal: combinedSignal,
            timeout: 120_000,
            cwd: xcodeArgs.execCwd,
          });
          const success = result.code === 0;
          debug("package clean exit code:", result.code, "success:", success);
          return {
            content: [
              {
                type: "text",
                text: success ? "✅ Clean succeeded." : `❌ Clean failed.\n${result.stderr}`,
              },
            ],
            details: { success, command: "swift package clean" },
          };
        } finally {
          clearOperation(state);
          stopSpinner(state);
          state.appStatus = "idle";
          updateStatusBar(cwd, state, ctx.ui);
        }
      }

      const schemeName = state.activeScheme?.name;
      const args = buildCleanArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: schemeName,
      });

      state.appStatus = "cleaning";
      startSpinner(cwd, state, ctx.ui);
      const combinedSignal = startOperation(state, `Clean ${schemeName ?? "project"}`, signal);
      try {
        debug("clean command: xcodebuild", args.join(" "));
        onUpdate?.({
          content: [{ type: "text", text: `Cleaning ${schemeName ?? "project"}...` }],
          details: undefined,
        });

        const result = await exec("xcodebuild", args, {
          signal: combinedSignal,
          timeout: 120_000,
          cwd: xcodeArgs.execCwd,
        });
        const success = result.code === 0;
        debug("clean exit code:", result.code, "success:", success);

        return {
          content: [
            {
              type: "text",
              text: success ? "✅ Clean succeeded." : `❌ Clean failed.\n${result.stderr}`,
            },
          ],
          details: { success, command: `xcodebuild ${args.join(" ")}` },
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
