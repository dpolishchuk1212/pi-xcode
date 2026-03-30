import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildBuildArgs, buildDestinationString, buildShowSettingsArgs } from "../commands.js";
import { formatBuildResult } from "../format.js";
import { createLogger } from "../log.js";
import { parseAppPath, parseBuildResult, parseBundleId } from "../parsers.js";
import { formatDestinationLabel, getXcodebuildProjectArgs } from "../resolve.js";
import {
  classifyDestination,
  destinationTypeLabel,
  ensureDestinationReady,
  installApp,
  launchApp,
  monitorAppLifecycle,
  terminateApp,
  uninstallApp,
} from "../runner.js";
import type { XcodeState } from "../state.js";
import { clearOperation, startOperation } from "../state.js";
import { startSpinner, stopSpinner, updateStatusBar } from "../status-bar.js";
import { createBuildExec } from "../streaming.js";
import type { Destination, ExecFn } from "../types.js";

const debug = createLogger("run");

export function registerRunTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_run",
    label: "Xcode Run",
    description:
      "Build, install, and launch the active app on the active destination (simulator, physical device, or Mac)",
    promptSnippet: "Build and run the active iOS/macOS app on the active destination",
    promptGuidelines: [
      "Use xcode_run to build, install, and launch the active app on the active destination.",
      "Always uses the active project, scheme, configuration, and destination. Use /project, /scheme, /destination, /configuration commands to change them.",
    ],
    parameters: Type.Object({
      skipBuild: Type.Optional(Type.Boolean({ description: "Skip the build step (default: false)" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      debug("params:", JSON.stringify(params));

      // ── Validate active state ───────────────────────────────────────
      if (!state.activeProject || !state.activeScheme) {
        throw new Error("No active project or scheme. Use /project and /scheme to select one.");
      }

      debug("active project:", state.activeProject.path, "scheme:", state.activeScheme.name);

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);
      const configuration = state.activeConfiguration ?? "Debug";

      // ── Resolve destination from active state ───────────────────────
      let dest: Destination | undefined;
      let destinationStr: string | undefined;

      if (state.activeDestination) {
        dest = state.activeDestination;
        destinationStr = buildDestinationString(dest);
      }

      if (!dest) {
        throw new Error("No destination available. Use /destination to select one, or pass a simulator name.");
      }

      const destLabel = formatDestinationLabel(dest);
      const destType = destinationTypeLabel(dest);
      debug("destination:", destLabel, "type:", destType, "id:", dest.id);

      const combinedSignal = startOperation(
        state,
        `Run ${state.activeScheme.name} (${configuration}) on ${destLabel}`,
        signal,
      );

      try {
        // ── Build ────────────────────────────────────────────────────────
        if (!params.skipBuild) {
          state.appStatus = "building";
          startSpinner(cwd, state, ctx.ui);

          const buildCmdArgs = buildBuildArgs({
            project: xcodeArgs.projectFlag,
            workspace: xcodeArgs.workspaceFlag,
            scheme: state.activeScheme.name,
            configuration,
            destination: destinationStr,
          });

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Building ${state.activeScheme.name} (${configuration}) for ${destLabel}...`,
              },
            ],
            details: undefined,
          });

          debug("build command: xcodebuild", buildCmdArgs.join(" "));
          const buildExecFn = createBuildExec(state, exec);
          const buildExec = await buildExecFn("xcodebuild", buildCmdArgs, {
            signal: combinedSignal,
            timeout: 600_000,
            cwd: xcodeArgs.execCwd,
          });
          debug("build exit code:", buildExec.code, "killed:", buildExec.killed);

          // Check for cancellation before parsing
          if (buildExec.killed || combinedSignal.aborted) {
            debug("run cancelled during build (killed=%s, aborted=%s)", buildExec.killed, combinedSignal.aborted);
            throw new Error("Run cancelled by user.");
          }

          const buildOutput = `${buildExec.stdout}\n${buildExec.stderr}`;
          const buildResult = parseBuildResult(buildOutput);
          debug("build success:", buildResult.success, "issues:", buildResult.issues.length);

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
          scheme: state.activeScheme.name,
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
        debug("bundleId:", bundleId, "appPath:", appPath);

        if (!bundleId || !appPath) {
          throw new Error(
            "Could not determine bundle ID or app path from build settings. " +
              "Make sure the scheme builds an app target.",
          );
        }

        // ── Stop previous monitor & terminate existing instance ──────────
        debug("terminating previous instance...");
        state.stopAppMonitor?.();
        state.stopAppMonitor = undefined;

        onUpdate?.({ content: [{ type: "text", text: `Terminating previous instance...` }], details: undefined });
        await terminateApp(exec, dest, bundleId, appPath);
        debug("previous instance terminated");

        // ── Boot / prepare destination ───────────────────────────────────
        debug("preparing destination:", destType);
        onUpdate?.({ content: [{ type: "text", text: `Preparing ${destType}...` }], details: undefined });
        await ensureDestinationReady(exec, dest);
        debug("destination ready");

        // ── Install & Launch (with force-refresh retry) ─────────────────
        debug("installing app:", appPath, "on:", destLabel);
        onUpdate?.({ content: [{ type: "text", text: `Installing on ${destLabel}...` }], details: undefined });
        await installApp(exec, dest, appPath, combinedSignal);
        debug("app installed");

        debug("launching:", bundleId);
        onUpdate?.({ content: [{ type: "text", text: `Launching ${bundleId}...` }], details: undefined });
        let launchResult = await launchApp(exec, dest, bundleId, appPath, combinedSignal);
        debug("launch result:", JSON.stringify(launchResult));

        // If the initial launch failed, force-refresh: uninstall → reinstall → relaunch.
        // This handles cases where a stale install or corrupted app container prevents launch.
        if (!launchResult.success) {
          debug("launch failed, attempting force-refresh: uninstall → reinstall → relaunch");
          onUpdate?.({
            content: [{ type: "text", text: `Launch failed, retrying with force refresh...` }],
            details: undefined,
          });

          await terminateApp(exec, dest, bundleId, appPath);
          await uninstallApp(exec, dest, bundleId);
          debug("force-refresh: uninstalled");

          // Small delay to let the simulator clean up
          await new Promise((r) => setTimeout(r, 1000));

          onUpdate?.({ content: [{ type: "text", text: `Reinstalling on ${destLabel}...` }], details: undefined });
          await installApp(exec, dest, appPath, combinedSignal);
          debug("force-refresh: reinstalled");

          onUpdate?.({ content: [{ type: "text", text: `Relaunching ${bundleId}...` }], details: undefined });
          launchResult = await launchApp(exec, dest, bundleId, appPath, combinedSignal);
          debug("force-refresh launch result:", JSON.stringify(launchResult));
        }

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
