import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExecFn } from "../types.js";
import type { XcodeState } from "../state.js";
import { startOperation, clearOperation } from "../state.js";
import {
  buildBuildArgs,
  buildDestinationString,
  buildShowSettingsArgs,
  buildSimulatorDestination,
  buildXctraceArgs,
} from "../commands.js";
import { parseAppPath, parseBuildResult } from "../parsers.js";
import { discoverSimulators, findSimulator } from "../discovery.js";
import { resolveProjectAndScheme, getXcodebuildProjectArgs, startSpinner, stopSpinner } from "../resolve.js";
import { formatBuildResult } from "../format.js";

const TEMPLATES = [
  "Time Profiler",
  "Allocations",
  "Leaks",
  "System Trace",
  "Animation Hitches",
  "App Launch",
  "Network",
  "SwiftUI",
] as const;

export function registerProfileTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_profile",
    label: "Xcode Profile",
    description:
      "Build the app and profile it with Instruments (xctrace). Supported templates: Time Profiler, Allocations, Leaks, System Trace, Animation Hitches, App Launch, Network, SwiftUI.",
    promptSnippet: "Profile an iOS app with Instruments (Time Profiler, Allocations, Leaks, etc.)",
    promptGuidelines: [
      "Use xcode_profile to profile apps. The trace file is saved and can be opened in Instruments.",
      "Default template is 'Time Profiler'. Set timeLimit to control how long profiling runs (seconds).",
    ],
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Path to .xcodeproj" })),
      workspace: Type.Optional(Type.String({ description: "Path to .xcworkspace" })),
      scheme: Type.Optional(Type.String({ description: "Build scheme" })),
      configuration: Type.Optional(Type.String({ description: "Debug or Release (default: Release)" })),
      simulator: Type.Optional(Type.String({ description: "Simulator name or UDID" })),
      template: Type.Optional(StringEnum(TEMPLATES, { description: "Instruments template (default: Time Profiler)" })),
      timeLimit: Type.Optional(Type.Number({ description: "Profiling time limit in seconds (default: 30)" })),
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

      // ── Find simulator: explicit param > active destination > auto-detect
      const simulators = await discoverSimulators(exec);

      let simUdid = params.simulator;
      if (!simUdid && state.activeDestination?.platform.includes("Simulator")) {
        simUdid = state.activeDestination.id;
      }

      const sim = findSimulator(simulators, simUdid);
      if (!sim) {
        throw new Error("No simulator found. Select a simulator destination with /destination.");
      }

      const destination = buildSimulatorDestination(sim.udid);
      const config = params.configuration ?? state.activeConfiguration ?? "Release";

      // ── Build ────────────────────────────────────────────────────────
      const buildCmdArgs = buildBuildArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: resolved.scheme,
        configuration: config,
        destination,
      });

      onUpdate?.({ content: [{ type: "text", text: `Building (${config}) for profiling...` }], details: undefined });

      const combinedSignal = startOperation(state, `Profile ${resolved.scheme ?? "project"} (${params.template ?? "Time Profiler"})`, signal);
      state.appStatus = "profiling";
      startSpinner(cwd, state, ctx.ui);

      try {
      const buildExec = await exec("xcodebuild", buildCmdArgs, { signal: combinedSignal, timeout: 600_000, cwd: xcodeArgs.execCwd });
      const buildOutput = buildExec.stdout + "\n" + buildExec.stderr;
      const buildResult = parseBuildResult(buildOutput);

      if (!buildResult.success) {
        return {
          content: [{ type: "text", text: `Build failed.\n\n${formatBuildResult(buildResult)}` }],
          details: { success: false, build: buildResult },
        };
      }

      // ── Get app path ─────────────────────────────────────────────────
      const settingsArgs = buildShowSettingsArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: resolved.scheme,
        configuration: config,
        destination,
      });

      const settingsResult = await exec("xcodebuild", settingsArgs, { signal: combinedSignal, timeout: 30_000, cwd: xcodeArgs.execCwd });
      const appPath = parseAppPath(settingsResult.stdout);

      if (!appPath) {
        throw new Error("Could not determine app path from build settings.");
      }

      // ── Profile ──────────────────────────────────────────────────────
      const template = params.template ?? "Time Profiler";
      const timeLimit = params.timeLimit ?? 30;

      const xctraceArgs = buildXctraceArgs({
        template,
        device: sim.udid,
        appPath,
        timeLimit,
      });

      onUpdate?.({
        content: [{ type: "text", text: `Profiling with ${template} for ${timeLimit}s...` }],
        details: undefined,
      });

      const profileResult = await exec("xcrun", xctraceArgs, { signal: combinedSignal, timeout: (timeLimit + 60) * 1000 });

      // xctrace writes the .trace path to stderr
      const traceMatch = profileResult.stderr.match(/Output file saved as (.+\.trace)/);
      const tracePath = traceMatch?.[1]?.trim();

      const success = profileResult.code === 0 && !!tracePath;

      const lines: string[] = [];
      if (success) {
        lines.push(`✅ Profiling complete (${template}, ${timeLimit}s)`);
        lines.push(`Trace file: ${tracePath}`);
        lines.push(`Open with: open "${tracePath}"`);
      } else {
        lines.push(`❌ Profiling failed.`);
        lines.push(profileResult.stderr);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          success,
          template,
          tracePath,
          simulator: sim.name,
        },
      };
      } finally {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
      }
    },
  });
}
