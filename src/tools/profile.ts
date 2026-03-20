import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExecFn } from "../types.js";
import type { XcodeState } from "../state.js";
import {
  buildBuildArgs,
  buildShowSettingsArgs,
  buildSimulatorDestination,
  buildXctraceArgs,
} from "../commands.js";
import { parseAppPath, parseBuildResult, parseBundleId } from "../parsers.js";
import { discover, autoSelect, discoverSimulators, findSimulator } from "../discovery.js";
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

    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Discovering project..." }], details: undefined });

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

      // Find simulator: explicit param > active simulator > auto-detect
      const simulators = await discoverSimulators(exec);
      const simNameOrUdid = params.simulator ?? state.activeSimulator?.udid;
      const sim = findSimulator(simulators, simNameOrUdid);
      if (!sim) {
        throw new Error("No simulator found. Specify one explicitly.");
      }

      const destination = buildSimulatorDestination(sim.udid);
      const config = params.configuration ?? "Release";

      // ── Build ────────────────────────────────────────────────────────
      const buildArgs = buildBuildArgs({
        project: params.workspace ? undefined : projectArg,
        workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
        scheme: schemeArg,
        configuration: config,
        destination,
      });

      onUpdate?.({ content: [{ type: "text", text: `Building (${config}) for profiling...` }], details: undefined });

      const buildExec = await exec("xcodebuild", buildArgs, { signal, timeout: 600_000 });
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
        project: params.workspace ? undefined : projectArg,
        workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
        scheme: schemeArg,
        configuration: config,
        destination,
      });

      const settingsResult = await exec("xcodebuild", settingsArgs, { signal, timeout: 30_000 });
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

      const profileResult = await exec("xcrun", xctraceArgs, { signal, timeout: (timeLimit + 60) * 1000 });

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
    },
  });
}
