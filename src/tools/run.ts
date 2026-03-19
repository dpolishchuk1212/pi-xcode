import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import {
  buildBuildArgs,
  buildShowSettingsArgs,
  buildSimctlBootArgs,
  buildSimctlInstallArgs,
  buildSimctlLaunchArgs,
  buildSimulatorDestination,
} from "../commands.js";
import { parseAppPath, parseBuildResult, parseBundleId } from "../parsers.js";
import { discover, autoSelect, discoverSimulators, findSimulator } from "../discovery.js";
import { formatBuildResult } from "../format.js";

export function registerRunTool(pi: ExtensionAPI, exec: ExecFn, cwd: string) {
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

    async execute(_toolCallId, params, signal, onUpdate) {
      // ── Discover project/scheme ──────────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: "Discovering project and simulator..." }] });

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

      // ── Find simulator ───────────────────────────────────────────────
      const simulators = await discoverSimulators(exec);
      const sim = findSimulator(simulators, params.simulator);

      if (!sim) {
        throw new Error(
          params.simulator
            ? `Simulator "${params.simulator}" not found. Available: ${simulators.map((s) => s.name).join(", ")}`
            : "No available simulators found.",
        );
      }

      const destination = buildSimulatorDestination(sim.udid);

      // ── Build ────────────────────────────────────────────────────────
      let buildOutput = "";

      if (!params.skipBuild) {
        const buildArgs = buildBuildArgs({
          project: params.workspace ? undefined : projectArg,
          workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
          scheme: schemeArg,
          configuration: params.configuration ?? "Debug",
          destination,
        });

        onUpdate?.({ content: [{ type: "text", text: `Building for ${sim.name}...` }] });

        const buildExec = await exec("xcodebuild", buildArgs, { signal, timeout: 600_000 });
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
      onUpdate?.({ content: [{ type: "text", text: "Resolving app info..." }] });

      const settingsArgs = buildShowSettingsArgs({
        project: params.workspace ? undefined : projectArg,
        workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
        scheme: schemeArg,
        configuration: params.configuration ?? "Debug",
        destination,
      });

      const settingsResult = await exec("xcodebuild", settingsArgs, { signal, timeout: 30_000 });
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
        onUpdate?.({ content: [{ type: "text", text: `Booting ${sim.name}...` }] });
        await exec("xcrun", buildSimctlBootArgs(sim.udid), { timeout: 30_000 });
        // Open Simulator.app
        await exec("open", ["-a", "Simulator"], { timeout: 5_000 });
      }

      // ── Install & launch ─────────────────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: `Installing on ${sim.name}...` }] });
      await exec("xcrun", buildSimctlInstallArgs(sim.udid, appPath), { signal, timeout: 60_000 });

      onUpdate?.({ content: [{ type: "text", text: `Launching ${bundleId}...` }] });
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
