import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import nodePath from "node:path";
import type { ExecFn } from "./types.js";
import { createState } from "./state.js";
import { discoverProjects } from "./discovery.js";
import {
  autoDetect,
  formatDestinationLabel,
  getXcodebuildProjectArgs,
  refreshConfigurations,
  refreshDestinations,
  refreshSchemes,
  updateStatusBar,
} from "./resolve.js";
import { buildBuildArgs, buildDestinationString, buildShowSettingsArgs } from "./commands.js";
import { parseAppPath, parseBuildResult, parseBundleId } from "./parsers.js";
import { formatBuildResult } from "./format.js";
import { terminateApp, ensureDestinationReady, installApp, launchApp, monitorAppLifecycle, destinationTypeLabel } from "./runner.js";
import { registerBuildTool } from "./tools/build.js";
import { registerCleanTool } from "./tools/clean.js";
import { registerDiscoverTool } from "./tools/discover.js";
import { registerRunTool } from "./tools/run.js";
import { registerTestTool } from "./tools/test.js";
import { registerProfileTool } from "./tools/profile.js";

function createExec(pi: ExtensionAPI): ExecFn {
  return (command, args, options) => pi.exec(command, args, options);
}

export default function (pi: ExtensionAPI) {
  const exec = createExec(pi);
  const state = createState();
  let sessionCwd = "";

  // ── /project command ─────────────────────────────────────────────────
  pi.registerCommand("project", {
    description: "Select the active Xcode project or workspace",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const projects = await discoverProjects(exec, cwd, 6);

      if (projects.length === 0) {
        ctx.ui.notify("No Xcode projects, workspaces, or Package.swift found.", "error");
        return;
      }

      const theme = ctx.ui.theme;

      const formatProject = (p: (typeof projects)[number]) => {
        const relativePath = nodePath.relative(cwd, p.path) || p.path;
        let label = relativePath;
        if (state.activeProject?.path === p.path) {
          label += theme.fg("accent", " ★ active");
        }
        return label;
      };

      const projectOptions = projects.map(formatProject);
      const projectChoice = await ctx.ui.select("Select a project:", projectOptions);
      if (projectChoice === undefined) return;

      const projectIdx = projectOptions.indexOf(projectChoice);
      const selectedProject = projectIdx >= 0 ? projects[projectIdx] : undefined;
      if (!selectedProject) return;

      // Save project, then cascade: auto-select scheme → auto-select destination
      state.activeProject = selectedProject;
      await refreshSchemes(exec, state, ctx.ui);
      updateStatusBar(cwd, state, ctx.ui);

      const relativePath = nodePath.relative(cwd, selectedProject.path) || selectedProject.path;
      const schemeInfo = state.activeScheme ? ` → scheme: ${state.activeScheme.name}` : "";
      const configInfo = state.activeConfiguration ? ` → config: ${state.activeConfiguration}` : "";
      const destInfo = state.activeDestination ? ` → dest: ${formatDestinationLabel(state.activeDestination)}` : "";
      ctx.ui.notify(`Active project: ${relativePath}${schemeInfo}${configInfo}${destInfo}`, "info");
    },
  });

  // ── /scheme command ──────────────────────────────────────────────────
  pi.registerCommand("scheme", {
    description: "Select the active scheme for builds",
    handler: async (_args, ctx) => {
      if (!state.activeProject) {
        ctx.ui.notify("No active project. Use /project first.", "error");
        return;
      }

      if (state.availableSchemes.length === 0) {
        ctx.ui.notify("No schemes available for this project.", "error");
        return;
      }

      const theme = ctx.ui.theme;

      const formatScheme = (s: (typeof state.availableSchemes)[number]) => {
        let label = s.name;
        if (state.activeScheme?.name === s.name) {
          label += theme.fg("accent", " ★ active");
        }
        return label;
      };

      const schemeOptions = state.availableSchemes.map(formatScheme);
      const schemeChoice = await ctx.ui.select("Select a scheme:", schemeOptions);
      if (schemeChoice === undefined) return;

      const schemeIdx = schemeOptions.indexOf(schemeChoice);
      const selectedScheme = schemeIdx >= 0 ? state.availableSchemes[schemeIdx] : undefined;
      if (!selectedScheme) return;

      // Save scheme, then cascade: refresh destinations
      state.activeScheme = selectedScheme;
      await refreshDestinations(exec, state, ctx.ui);
      updateStatusBar(ctx.cwd, state, ctx.ui);

      const destInfo = state.activeDestination ? ` → dest: ${formatDestinationLabel(state.activeDestination)}` : "";
      ctx.ui.notify(`Active scheme: ${selectedScheme.name}${destInfo}`, "info");
    },
  });

  // ── /destination command ─────────────────────────────────────────────
  pi.registerCommand("destination", {
    description: "Select the run destination (simulator, device, or Mac) for builds and runs",
    handler: async (_args, ctx) => {
      if (!state.activeProject || !state.activeScheme) {
        ctx.ui.notify("No active project/scheme. Use /project first.", "error");
        return;
      }

      if (state.availableDestinations.length === 0) {
        ctx.ui.notify("No destinations available for this project.", "error");
        return;
      }

      const theme = ctx.ui.theme;
      const destinations = state.availableDestinations.filter((d) => !d.id.includes("placeholder"));

      if (destinations.length === 0) {
        ctx.ui.notify("No concrete destinations available (only placeholders found).", "error");
        return;
      }

      // Sort: physical devices first, then Mac, then simulators
      const sortOrder = (d: (typeof destinations)[number]) => {
        if (!d.platform.includes("Simulator") && d.platform !== "macOS") return 0; // physical device
        if (d.platform === "macOS") return 1;
        return 2; // simulator
      };
      const sorted = [...destinations].sort((a, b) => sortOrder(a) - sortOrder(b));

      const formatOption = (d: (typeof sorted)[number]) => {
        let label = formatDestinationLabel(d);
        if (state.activeDestination?.id === d.id) {
          label += theme.fg("accent", " ★ active");
        }
        label += " " + theme.fg("dim", `[${d.platform}]`);
        return label;
      };

      const options = sorted.map(formatOption);
      const choice = await ctx.ui.select("Select run destination:", options);
      if (choice === undefined) return;

      const selectedIndex = options.indexOf(choice);
      const selected = selectedIndex >= 0 ? sorted[selectedIndex] : undefined;
      if (!selected) return;

      state.activeDestination = selected;
      updateStatusBar(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(`Run destination: ${formatDestinationLabel(selected)}`, "info");
    },
  });

  // ── /configuration command ────────────────────────────────────────────
  pi.registerCommand("configuration", {
    description: "Select the build configuration (Debug, Release, etc.)",
    handler: async (_args, ctx) => {
      if (!state.activeProject) {
        ctx.ui.notify("No active project. Use /project first.", "error");
        return;
      }

      if (state.availableConfigurations.length === 0) {
        ctx.ui.notify("No build configurations available for this project.", "error");
        return;
      }

      const theme = ctx.ui.theme;

      const formatConfig = (c: string) => {
        let label = c;
        if (state.activeConfiguration === c) {
          label += theme.fg("accent", " ★ active");
        }
        return label;
      };

      const configOptions = state.availableConfigurations.map(formatConfig);
      const choice = await ctx.ui.select("Select build configuration:", configOptions);
      if (choice === undefined) return;

      const idx = configOptions.indexOf(choice);
      const selected = idx >= 0 ? state.availableConfigurations[idx] : undefined;
      if (!selected) return;

      state.activeConfiguration = selected;
      updateStatusBar(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(`Build configuration: ${selected}`, "info");
    },
  });

  // ── /build command ────────────────────────────────────────────────────
  pi.registerCommand("build", {
    description: "Build the active project with current scheme, configuration, and destination",
    handler: async (_args, ctx) => {
      if (!state.activeProject || !state.activeScheme) {
        ctx.ui.notify("No active project/scheme. Use /project first.", "error");
        return;
      }

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);
      const configuration = state.activeConfiguration ?? "Debug";

      let destination: string | undefined;
      let destinationLabel: string | undefined;
      if (state.activeDestination) {
        destination = buildDestinationString(state.activeDestination);
        destinationLabel = formatDestinationLabel(state.activeDestination);
      }

      const args = buildBuildArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: state.activeScheme.name,
        configuration,
        destination,
      });

      const destSuffix = destinationLabel ? ` → ${destinationLabel}` : "";
      state.appStatus = "building";
      updateStatusBar(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(`Building ${state.activeScheme.name} (${configuration})${destSuffix}...`, "info");

      const result = await exec("xcodebuild", args, { timeout: 600_000, cwd: xcodeArgs.execCwd });
      const combined = result.stdout + "\n" + result.stderr;
      const buildResult = parseBuildResult(combined);

      state.appStatus = "idle";
      updateStatusBar(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(formatBuildResult(buildResult), buildResult.success ? "info" : "error");
    },
  });

  // ── /run command ─────────────────────────────────────────────────────
  pi.registerCommand("run", {
    description: "Build and run the app on the active destination. Usage: /run [scheme]",
    handler: async (args, ctx) => {
      if (!state.activeProject) {
        ctx.ui.notify("No active project. Use /project first.", "error");
        return;
      }

      // Optional scheme argument
      const schemeArg = args?.trim() || undefined;
      const scheme = schemeArg
        ? state.availableSchemes.find((s) => s.name === schemeArg)?.name ?? schemeArg
        : state.activeScheme?.name;

      if (!scheme) {
        ctx.ui.notify("No scheme available. Use /scheme to select one.", "error");
        return;
      }

      const dest = state.activeDestination;
      if (!dest) {
        ctx.ui.notify("No destination available. Use /destination to select one.", "error");
        return;
      }

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);
      const configuration = state.activeConfiguration ?? "Debug";
      const destinationStr = buildDestinationString(dest);
      const destLabel = formatDestinationLabel(dest);
      const destType = destinationTypeLabel(dest);

      // ── Build ──────────────────────────────────────────────────────
      state.appStatus = "building";
      updateStatusBar(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(`Building ${scheme} (${configuration}) for ${destLabel}...`, "info");

      const buildCmdArgs = buildBuildArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme,
        configuration,
        destination: destinationStr,
      });

      const buildExec = await exec("xcodebuild", buildCmdArgs, { timeout: 600_000, cwd: xcodeArgs.execCwd });
      const buildOutput = buildExec.stdout + "\n" + buildExec.stderr;
      const buildResult = parseBuildResult(buildOutput);

      if (!buildResult.success) {
        state.appStatus = "idle";
        updateStatusBar(ctx.cwd, state, ctx.ui);
        ctx.ui.notify(formatBuildResult(buildResult), "error");
        return;
      }

      // ── Resolve bundle ID & app path ───────────────────────────────
      const settingsArgs = buildShowSettingsArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme,
        configuration,
        destination: destinationStr,
      });

      const settingsResult = await exec("xcodebuild", settingsArgs, { timeout: 30_000, cwd: xcodeArgs.execCwd });
      const bundleId = parseBundleId(settingsResult.stdout);
      const appPath = parseAppPath(settingsResult.stdout);

      if (!bundleId || !appPath) {
        state.appStatus = "idle";
        updateStatusBar(ctx.cwd, state, ctx.ui);
        ctx.ui.notify("Could not determine bundle ID or app path. Make sure the scheme builds an app target.", "error");
        return;
      }

      // ── Stop previous monitor → Terminate → Boot → Install → Launch ─
      state.stopAppMonitor?.();
      state.stopAppMonitor = undefined;

      await terminateApp(exec, dest, bundleId, appPath);
      await ensureDestinationReady(exec, dest);

      ctx.ui.notify(`Installing on ${destLabel}...`, "info");
      await installApp(exec, dest, appPath);

      ctx.ui.notify(`Launching ${bundleId}...`, "info");
      const launchResult = await launchApp(exec, dest, bundleId, appPath);

      if (launchResult.success) {
        state.appStatus = "running";
        updateStatusBar(ctx.cwd, state, ctx.ui);

        // Start monitoring — auto-update status when app exits
        if (launchResult.pid) {
          state.stopAppMonitor = monitorAppLifecycle(exec, launchResult.pid, () => {
            state.appStatus = "idle";
            state.stopAppMonitor = undefined;
            updateStatusBar(ctx.cwd, state, ctx.ui);
          });
        }

        ctx.ui.notify(`✅ ${scheme} launched on ${destLabel} [${destType}]`, "info");
      } else {
        state.appStatus = "idle";
        updateStatusBar(ctx.cwd, state, ctx.ui);
        ctx.ui.notify(`❌ Failed to launch on ${destLabel}: ${launchResult.error ?? "unknown error"}`, "error");
      }
    },
  });

  // ── Register tools (override built-in xcode tools) ────────────────────
  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    registerBuildTool(pi, exec, sessionCwd, state);
    registerCleanTool(pi, exec, sessionCwd, state);
    registerDiscoverTool(pi, exec, sessionCwd);
    registerRunTool(pi, exec, sessionCwd, state);
    registerTestTool(pi, exec, sessionCwd, state);
    registerProfileTool(pi, exec, sessionCwd, state);

    // Replace built-in xcode tools with our versions
    const builtInXcodeTools = ["xcode_build", "xcode_clean", "xcode_discover", "xcode_run", "xcode_test", "xcode_profile"];
    const currentTools = pi.getActiveTools();
    const withoutBuiltIn = currentTools.filter((t) => !builtInXcodeTools.includes(t));
    pi.setActiveTools([...withoutBuiltIn, ...builtInXcodeTools]);

    // Auto-detect project → scheme → destination silently
    await autoDetect(exec, sessionCwd, state, ctx.ui);
  });
}
