import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildBuildArgs,
  buildDestinationString,
  buildShowSettingsArgs,
  buildSimulatorDestination,
} from "../commands.js";
import { discoverSimulators, findSimulator } from "../discovery.js";
import { formatBuildResult } from "../format.js";
import { parseAppPath, parseBuildResult, parseBundleId } from "../parsers.js";
import { formatDestinationLabel, getXcodebuildProjectArgs, resolveProjectAndScheme } from "../resolve.js";
import {
  classifyDestination,
  destinationTypeLabel,
  ensureDestinationReady,
  installApp,
  launchApp,
  monitorAppLifecycle,
  terminateApp,
} from "../runner.js";
import type { XcodeState } from "../state.js";
import { clearOperation, startOperation } from "../state.js";
import { startSpinner, stopSpinner, updateStatusBar } from "../status-bar.js";
import { createBuildExec } from "../streaming.js";
import type { Destination, ExecFn } from "../types.js";

export function registerRunTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_run",
    label: "Xcode Run",
    description:
      "Build, install, and launch an app on the target destination (simulator, physical device, or Mac). " +
      "Auto-discovers project, workspace, scheme, and destination when not specified.",
    promptSnippet: "Build and run an iOS/macOS app on the active destination",
    promptGuidelines: [
      "Use xcode_run to build and launch apps on the active destination.",
      "Omit all parameters to use the already-selected project, scheme, configuration, and destination.",
      "Only pass parameters if the user explicitly asks to use something different than what is selected.",
    ],
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Path to .xcodeproj" })),
      workspace: Type.Optional(Type.String({ description: "Path to .xcworkspace" })),
      scheme: Type.Optional(Type.String({ description: "Build scheme (auto-discovered if omitted)" })),
      configuration: Type.Optional(Type.String({ description: "Debug or Release (default: Debug)" })),
      simulator: Type.Optional(
        Type.String({ description: "Simulator name or UDID (shorthand for simulator destination)" }),
      ),
      skipBuild: Type.Optional(Type.Boolean({ description: "Skip the build step (default: false)" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // ── Resolve project/scheme ──────────────────────────────────────
      onUpdate?.({ content: [{ type: "text", text: "Resolving project..." }], details: undefined });

      const resolved = await resolveProjectAndScheme(exec, cwd, state, ctx.ui, {
        project: params.project,
        workspace: params.workspace,
        scheme: params.scheme,
      });

      const xcodeArgs = getXcodebuildProjectArgs(resolved.project);
      const configuration = params.configuration ?? state.activeConfiguration ?? "Debug";

      // ── Resolve destination ─────────────────────────────────────────
      let dest: Destination | undefined;
      let destinationStr: string | undefined;

      if (params.simulator) {
        // Explicit simulator shorthand → find the simulator
        const simulators = await discoverSimulators(exec);
        const sim = findSimulator(simulators, params.simulator);
        if (!sim) {
          throw new Error(
            `Simulator "${params.simulator}" not found. Available: ${simulators.map((s) => s.name).join(", ")}`,
          );
        }
        dest = {
          platform: "iOS Simulator",
          id: sim.udid,
          name: sim.name,
          os: sim.runtime.replace(/.*\./, "").replace(/-/g, "."),
          arch: "arm64",
        };
        destinationStr = buildSimulatorDestination(sim.udid);
      } else if (state.activeDestination) {
        dest = state.activeDestination;
        destinationStr = buildDestinationString(dest);
      }

      if (!dest) {
        throw new Error("No destination available. Use /destination to select one, or pass a simulator name.");
      }

      const destLabel = formatDestinationLabel(dest);
      const destType = destinationTypeLabel(dest);

      const combinedSignal = startOperation(state, `Run ${resolved.scheme ?? "project"} on ${destLabel}`, signal);

      try {
        // ── Build ────────────────────────────────────────────────────────
        if (!params.skipBuild) {
          state.appStatus = "building";
          startSpinner(cwd, state, ctx.ui);

          const buildCmdArgs = buildBuildArgs({
            project: xcodeArgs.projectFlag,
            workspace: xcodeArgs.workspaceFlag,
            scheme: resolved.scheme,
            configuration,
            destination: destinationStr,
          });

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Building ${resolved.scheme ?? "project"} (${configuration}) for ${destLabel}...`,
              },
            ],
            details: undefined,
          });

          const buildExecFn = createBuildExec(state, exec);
          const buildExec = await buildExecFn("xcodebuild", buildCmdArgs, {
            signal: combinedSignal,
            timeout: 600_000,
            cwd: xcodeArgs.execCwd,
          });
          const buildOutput = `${buildExec.stdout}\n${buildExec.stderr}`;
          const buildResult = parseBuildResult(buildOutput);

          if (!buildResult.success) {
            // Must clean up here — return doesn't trigger catch
            clearOperation(state);
            stopSpinner(state);
            state.appStatus = "idle";
            updateStatusBar(cwd, state, ctx.ui);
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
          configuration,
          destination: destinationStr,
        });

        const settingsResult = await exec("xcodebuild", settingsArgs, {
          signal: combinedSignal,
          timeout: 30_000,
          cwd: xcodeArgs.execCwd,
        });
        const settingsOutput = settingsResult.stdout;
        const bundleId = parseBundleId(settingsOutput);
        const appPath = parseAppPath(settingsOutput);

        if (!bundleId || !appPath) {
          throw new Error(
            "Could not determine bundle ID or app path from build settings. " +
              "Make sure the scheme builds an app target.",
          );
        }

        // ── Stop previous monitor & terminate existing instance ──────────
        state.stopAppMonitor?.();
        state.stopAppMonitor = undefined;

        onUpdate?.({ content: [{ type: "text", text: `Terminating previous instance...` }], details: undefined });
        await terminateApp(exec, dest, bundleId, appPath);

        // ── Boot / prepare destination ───────────────────────────────────
        onUpdate?.({ content: [{ type: "text", text: `Preparing ${destType}...` }], details: undefined });
        await ensureDestinationReady(exec, dest);

        // ── Install ──────────────────────────────────────────────────────
        onUpdate?.({ content: [{ type: "text", text: `Installing on ${destLabel}...` }], details: undefined });
        await installApp(exec, dest, appPath, combinedSignal);

        // ── Launch ───────────────────────────────────────────────────────
        onUpdate?.({ content: [{ type: "text", text: `Launching ${bundleId}...` }], details: undefined });
        const launchResult = await launchApp(exec, dest, bundleId, appPath, combinedSignal);

        // Operation complete (build+install+launch phase is done)
        clearOperation(state);
        stopSpinner(state);

        if (launchResult.success) {
          state.appStatus = "running";

          // Start monitoring the app process — update status when it exits
          if (launchResult.pid) {
            state.stopAppMonitor = monitorAppLifecycle(exec, launchResult.pid, () => {
              state.appStatus = "idle";
              state.stopAppMonitor = undefined;
              updateStatusBar(cwd, state, ctx.ui);
            });
          }
        } else {
          state.appStatus = "idle";
        }
        updateStatusBar(cwd, state, ctx.ui);

        const lines: string[] = [];
        if (launchResult.success) {
          lines.push(`✅ App launched on ${destLabel}`);
        } else {
          lines.push(`❌ Failed to launch on ${destLabel}`);
          if (launchResult.error) lines.push(`Error: ${launchResult.error}`);
        }
        lines.push(`Bundle ID: ${bundleId}`);
        lines.push(`Destination: ${destLabel} [${destType}]`);
        lines.push(`Configuration: ${configuration}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            success: launchResult.success,
            launched: launchResult.success,
            bundleId,
            destination: destLabel,
            destinationType: classifyDestination(dest),
            appPath,
            configuration,
          },
        };
      } catch (e) {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
        updateStatusBar(cwd, state, ctx.ui);
        throw e;
      }
    },
  });
}
