import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildCleanArgs } from "../commands.js";
import {
  getXcodebuildProjectArgs,
  resolveProjectAndScheme,
  startSpinner,
  stopSpinner,
  updateStatusBar,
} from "../resolve.js";
import type { XcodeState } from "../state.js";
import { clearOperation, startOperation } from "../state.js";
import type { ExecFn } from "../types.js";
import { stopActiveOperation } from "./stop.js";

export function registerCleanTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
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

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // ── Stop any active operation first ──────────────────────────────
      if (state.appStatus !== "idle") {
        await stopActiveOperation(exec, cwd, state, ctx.ui);
      }

      // ── Resolve project and scheme ───────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: "Discovering project..." }], details: undefined });

      const resolved = await resolveProjectAndScheme(exec, cwd, state, ctx.ui, {
        project: params.project,
        workspace: params.workspace,
        scheme: params.scheme,
      });

      const xcodeArgs = getXcodebuildProjectArgs(resolved.project);

      // For Package.swift, use `swift package clean` which is more idiomatic
      if (resolved.project.type === "package") {
        state.appStatus = "cleaning";
        startSpinner(cwd, state, ctx.ui);
        const combinedSignal = startOperation(state, "Clean package", signal);
        try {
          onUpdate?.({ content: [{ type: "text", text: "Cleaning package..." }], details: undefined });
          const result = await exec("swift", ["package", "clean"], {
            signal: combinedSignal,
            timeout: 120_000,
            cwd: xcodeArgs.execCwd,
          });
          const success = result.code === 0;
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

      const args = buildCleanArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: resolved.scheme,
      });

      state.appStatus = "cleaning";
      startSpinner(cwd, state, ctx.ui);
      const combinedSignal = startOperation(state, `Clean ${resolved.scheme ?? "project"}`, signal);
      try {
        onUpdate?.({
          content: [{ type: "text", text: `Cleaning: xcodebuild ${args.join(" ")}` }],
          details: undefined,
        });

        const result = await exec("xcodebuild", args, {
          signal: combinedSignal,
          timeout: 120_000,
          cwd: xcodeArgs.execCwd,
        });
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
      } finally {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
        updateStatusBar(cwd, state, ctx.ui);
      }
    },
  });
}
