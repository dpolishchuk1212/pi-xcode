import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import type { XcodeState } from "../state.js";
import {
  buildBuildArgs,
  buildDestinationString,
  buildShowSettingsArgs,
  buildSimctlBootArgs,
  buildSimctlInstallArgs,
  buildSimctlLaunchArgs,
  buildSimulatorDestination,
} from "../commands.js";
import { parseAppPath, parseBuildResult, parseBundleId } from "../parsers.js";
import { discoverSimulators, findSimulator } from "../discovery.js";
import { resolveProjectAndScheme, getXcodebuildProjectArgs, formatDestinationLabel } from "../resolve.js";
import { formatBuildResult } from "../format.js";

export function registerRunTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_run",
    label: "Xcode Run",
    description:
      "Build, install, and launch an app on the iOS Simulator. Auto-discovers project, workspace, scheme, and simulator when not specified.",
    promptSnippet: "Build and run an iOS app on the Simulator",
    promptGuidelines: [
      "Use xcode_run to build and launch iOS apps on the Simulator.",
      "Omit simulator to auto-select the latest iPhone.",
    ],
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Path to .xcodeproj" })),
      workspace: Type.Optional(Type.String({ description: "Path to .xcworkspace" })),
      scheme: Type.Optional(Type.String({ description: "Build scheme (auto-discovered if omitted)" })),
      configuration: Type.Optional(Type.String({ description: "Debug or Release (default: Debug)" })),
      simulator: Type.Optional(Type.String({ description: "Simulator name or UDID (default: latest iPhone)" })),
      skipBuild: Type.Optional(Type.Boolean({ description: "Skip the build step (default: false)" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // ── Resolve project/scheme ──────────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: "Discovering project and simulator..." }], details: undefined });

      const resolved = await resolveProjectAndScheme(exec, cwd, state, ctx.ui, {
        project: params.project,
        workspace: params.workspace,
        scheme: params.scheme,
      });

      const xcodeArgs = getXcodebuildProjectArgs(resolved.project);

      // ── Find simulator: explicit param > active destination > auto-detect
      // The run tool needs an actual simulator for simctl boot/install/launch
      const simulators = await discoverSimulators(exec);

      let simUdid = params.simulator;
      if (!simUdid && state.activeDestination?.platform.includes("Simulator")) {
        simUdid = state.activeDestination.id;
      }

      const sim = findSimulator(simulators, simUdid);

      if (!sim) {
        throw new Error(
          params.simulator
            ? `Simulator "${params.simulator}" not found. Available: ${simulators.map((s) => s.name).join(", ")}`
            : "No available simulator found. Select a simulator destination with /destination.",
        );
      }

      const destination = buildSimulatorDestination(sim.udid);

      // ── Build ────────────────────────────────────────────────────────
      let buildOutput = "";

      if (!params.skipBuild) {
        const buildCmdArgs = buildBuildArgs({
          project: xcodeArgs.projectFlag,
          workspace: xcodeArgs.workspaceFlag,
          scheme: resolved.scheme,
          configuration: params.configuration ?? "Debug",
          destination,
        });

        onUpdate?.({ content: [{ type: "text", text: `Building for ${sim.name}...` }], details: undefined });

        const buildExec = await exec("xcodebuild", buildCmdArgs, { signal, timeout: 600_000, cwd: xcodeArgs.execCwd });
        buildOutput = buildExec.stdout + "\n" + buildExec.stderr;
        const buildResult = parseBuildResult(buildOutput);

        if (!buildResult.success) {
          return {
            content: [{ type: "text", text: `Build failed.\n\n${formatBuildResult(buildResult)}` }],
            details: { success: false, build: buildResult, launched: false },
          };
        }
      }

      // ── Get bundle ID and app path ───────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: "Resolving app info..." }], details: undefined });

      const settingsArgs = buildShowSettingsArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: resolved.scheme,
        configuration: params.configuration ?? "Debug",
        destination,
      });

      const settingsResult = await exec("xcodebuild", settingsArgs, { signal, timeout: 30_000, cwd: xcodeArgs.execCwd });
      const settingsOutput = settingsResult.stdout;
      const bundleId = parseBundleId(settingsOutput);
      const appPath = parseAppPath(settingsOutput);

      if (!bundleId || !appPath) {
        throw new Error(
          "Could not determine bundle ID or app path from build settings. " +
            "Make sure the scheme builds an app target.",
        );
      }

      // ── Boot simulator ───────────────────────────────────────────────
      if (sim.state !== "Booted") {
        onUpdate?.({ content: [{ type: "text", text: `Booting ${sim.name}...` }], details: undefined });
        await exec("xcrun", buildSimctlBootArgs(sim.udid), { timeout: 30_000 });
        // Open Simulator.app
        await exec("open", ["-a", "Simulator"], { timeout: 5_000 });
      }

      // ── Install & launch ─────────────────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: `Installing on ${sim.name}...` }], details: undefined });
      await exec("xcrun", buildSimctlInstallArgs(sim.udid, appPath), { signal, timeout: 60_000 });

      onUpdate?.({ content: [{ type: "text", text: `Launching ${bundleId}...` }], details: undefined });
      const launchResult = await exec("xcrun", buildSimctlLaunchArgs(sim.udid, bundleId), {
        signal,
        timeout: 30_000,
      });

      const launched = launchResult.code === 0;

      const lines = [`✅ App launched on ${sim.name}`];
      lines.push(`Bundle ID: ${bundleId}`);
      lines.push(`Simulator: ${sim.name} (${sim.runtime})`);
      if (!launched) {
        lines[0] = `❌ Failed to launch on ${sim.name}`;
        lines.push(`Launch error: ${launchResult.stderr}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          success: launched,
          launched,
          bundleId,
          simulator: sim.name,
          appPath,
        },
      };
    },
  });
}
