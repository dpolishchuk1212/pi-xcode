import nodePath from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getSelectListTheme } from "@mariozechner/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { buildBuildArgs, buildDestinationString, buildShowSettingsArgs, buildTestArgs } from "./commands.js";
import { discoverProjects } from "./discovery.js";
import { formatBuildResult } from "./format.js";
import { parseAppPath, parseBuildResult, parseBundleId, parseTestResult } from "./parsers.js";
import {
  autoDetect,
  formatDestinationLabel,
  getXcodebuildProjectArgs,
  refreshDestinations,
  refreshSchemes,
  startSpinner,
  stopSpinner,
  updateStatusBar,
} from "./resolve.js";
import {
  destinationTypeLabel,
  ensureDestinationReady,
  installApp,
  launchApp,
  monitorAppLifecycle,
  terminateApp,
} from "./runner.js";
import { clearOperation, createState, startOperation } from "./state.js";
import { createBuildExec, createTestExec } from "./streaming.js";
import { registerBuildTool } from "./tools/build.js";
import { registerRunTool } from "./tools/run.js";
import { registerStopTool, stopActiveOperation } from "./tools/stop.js";
import { registerTestTool } from "./tools/test.js";
import type { ExecFn, SchemeProductType } from "./types.js";

function createExec(pi: ExtensionAPI): ExecFn {
  return (command, args, options) => pi.exec(command, args, options);
}

// ── Reusable select dialog with DynamicBorder, scrolling, and fuzzy search ──

const MAX_VISIBLE = 20;

async function showFilterableSelect(ctx: ExtensionContext, title: string, items: SelectItem[]): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
    const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
    const selectTheme = getSelectListTheme();

    const searchInput = new Input();
    let filteredItems = items;

    function makeSelectList(listItems: SelectItem[]) {
      const sl = new SelectList(listItems, Math.min(listItems.length, MAX_VISIBLE), selectTheme);
      sl.onSelect = (item) => done(item.value);
      sl.onCancel = () => done(null);
      return sl;
    }

    let currentSelectList = makeSelectList(filteredItems);

    function applyFilter() {
      const query = searchInput.getValue();
      filteredItems = query ? fuzzyFilter(items, query, (item) => item.label) : items;
      currentSelectList = makeSelectList(filteredItems);
    }

    return {
      render: (w: number) => {
        const lines: string[] = [];
        lines.push(...topBorder.render(w));
        lines.push(
          truncateToWidth(
            ` ${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", `(${filteredItems.length})`)}`,
            w,
          ),
        );
        lines.push(...searchInput.render(w));
        lines.push("");
        lines.push(...currentSelectList.render(w));
        lines.push(truncateToWidth(theme.fg("dim", " ↑↓ navigate • type to filter • enter select • esc cancel"), w));
        lines.push(...bottomBorder.render(w));
        return lines;
      },
      invalidate: () => {
        topBorder.invalidate();
        bottomBorder.invalidate();
        searchInput.invalidate();
        currentSelectList.invalidate();
      },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
          currentSelectList.handleInput(data);
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          if (searchInput.getValue()) {
            searchInput.setValue("");
            applyFilter();
          } else {
            done(null);
          }
        } else {
          searchInput.handleInput(data);
          applyFilter();
        }
        tui.requestRender();
      },
    };
  });
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

      const items: SelectItem[] = projects.map((p) => {
        const relativePath = nodePath.relative(cwd, p.path) || p.path;
        const isActive = state.activeProject?.path === p.path;
        return {
          value: p.path,
          label: isActive ? `${relativePath} ★` : relativePath,
          description: p.type,
        };
      });

      const result = await showFilterableSelect(ctx, "Projects", items);
      if (!result) return;

      const selectedProject = projects.find((p) => p.path === result);
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

      const productTypeLabel = (t?: SchemeProductType): string => {
        switch (t) {
          case "app":
            return "Application";
          case "framework":
            return "Framework";
          case "test":
            return "Tests";
          case "extension":
            return "Extension";
          default:
            return "";
        }
      };

      const items: SelectItem[] = state.availableSchemes.map((s) => {
        const isActive = state.activeScheme?.name === s.name;
        return {
          value: s.name,
          label: isActive ? `${s.name} ★` : s.name,
          description: productTypeLabel(s.productType),
        };
      });

      const result = await showFilterableSelect(ctx, "Schemes", items);
      if (!result) return;

      const selectedScheme = state.availableSchemes.find((s) => s.name === result);
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

      const items: SelectItem[] = sorted.map((d) => {
        const isActive = state.activeDestination?.id === d.id;
        const label = formatDestinationLabel(d);
        return {
          value: d.id,
          label: isActive ? `${label} ★` : label,
          description: d.platform,
        };
      });

      const result = await showFilterableSelect(ctx, "Destinations", items);
      if (!result) return;

      const selected = sorted.find((d) => d.id === result);
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

      const items: SelectItem[] = state.availableConfigurations.map((c) => {
        const isActive = state.activeConfiguration === c;
        return {
          value: c,
          label: isActive ? `${c} ★` : c,
        };
      });

      const result = await showFilterableSelect(ctx, "Configurations", items);
      if (!result) return;

      state.activeConfiguration = result;
      updateStatusBar(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(`Build configuration: ${result}`, "info");
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
      startSpinner(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(`Building ${state.activeScheme.name} (${configuration})${destSuffix}...`, "info");

      const signal = startOperation(state, `Build ${state.activeScheme.name} (${configuration})${destSuffix}`);
      try {
        const buildExec = createBuildExec(state);
        const result = await buildExec("xcodebuild", args, { signal, timeout: 600_000, cwd: xcodeArgs.execCwd });
        const combined = `${result.stdout}\n${result.stderr}`;
        const buildResult = parseBuildResult(combined);

        ctx.ui.notify(formatBuildResult(buildResult), buildResult.success ? "info" : "error");
      } finally {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
        updateStatusBar(ctx.cwd, state, ctx.ui);
      }
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
        ? (state.availableSchemes.find((s) => s.name === schemeArg)?.name ?? schemeArg)
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

      const signal = startOperation(state, `Run ${scheme} on ${destLabel}`);

      try {
        // ── Build ──────────────────────────────────────────────────────
        state.appStatus = "building";
        startSpinner(ctx.cwd, state, ctx.ui);
        ctx.ui.notify(`Building ${scheme} (${configuration}) for ${destLabel}...`, "info");

        const buildCmdArgs = buildBuildArgs({
          project: xcodeArgs.projectFlag,
          workspace: xcodeArgs.workspaceFlag,
          scheme,
          configuration,
          destination: destinationStr,
        });

        const streamingExec = createBuildExec(state);
        const buildExec = await streamingExec("xcodebuild", buildCmdArgs, {
          signal,
          timeout: 600_000,
          cwd: xcodeArgs.execCwd,
        });
        const buildOutput = `${buildExec.stdout}\n${buildExec.stderr}`;
        const buildResult = parseBuildResult(buildOutput);

        if (!buildResult.success) {
          stopSpinner(state);
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

        const settingsResult = await exec("xcodebuild", settingsArgs, {
          signal,
          timeout: 30_000,
          cwd: xcodeArgs.execCwd,
        });
        const bundleId = parseBundleId(settingsResult.stdout);
        const appPath = parseAppPath(settingsResult.stdout);

        if (!bundleId || !appPath) {
          stopSpinner(state);
          state.appStatus = "idle";
          updateStatusBar(ctx.cwd, state, ctx.ui);
          ctx.ui.notify(
            "Could not determine bundle ID or app path. Make sure the scheme builds an app target.",
            "error",
          );
          return;
        }

        // ── Stop previous monitor → Terminate → Boot → Install → Launch ─
        state.stopAppMonitor?.();
        state.stopAppMonitor = undefined;

        await terminateApp(exec, dest, bundleId, appPath);
        await ensureDestinationReady(exec, dest);

        ctx.ui.notify(`Installing on ${destLabel}...`, "info");
        await installApp(exec, dest, appPath, signal);

        ctx.ui.notify(`Launching ${bundleId}...`, "info");
        const launchResult = await launchApp(exec, dest, bundleId, appPath, signal);

        // Clear the operation before entering "running" state (build+launch phase done)
        clearOperation(state);
        stopSpinner(state);

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
      } catch (e) {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
        updateStatusBar(ctx.cwd, state, ctx.ui);
        throw e;
      }
    },
  });

  // ── /test command ────────────────────────────────────────────────────
  pi.registerCommand("test", {
    description: "Run tests for the active project. Usage: /test [testFilter] [--plan <testPlan>]",
    handler: async (args, ctx) => {
      if (!state.activeProject || !state.activeScheme) {
        ctx.ui.notify("No active project/scheme. Use /project first.", "error");
        return;
      }

      const dest = state.activeDestination;
      if (!dest) {
        ctx.ui.notify("No destination available. Use /destination to select one.", "error");
        return;
      }

      // Parse arguments: /test [testFilter] [--plan <testPlan>]
      const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
      let testPlan: string | undefined;
      const onlyTesting: string[] = [];

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--plan" && i + 1 < parts.length) {
          testPlan = parts[++i];
        } else {
          onlyTesting.push(parts[i]);
        }
      }

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);
      const configuration = state.activeConfiguration ?? "Debug";
      const destinationStr = buildDestinationString(dest);
      const destLabel = formatDestinationLabel(dest);

      const testArgs = buildTestArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: state.activeScheme.name,
        configuration,
        destination: destinationStr,
        testPlan,
        onlyTesting: onlyTesting.length > 0 ? onlyTesting : undefined,
      });

      const filterLabel = onlyTesting.length > 0 ? ` (${onlyTesting.join(", ")})` : "";
      const planLabel = testPlan ? ` [plan: ${testPlan}]` : "";
      state.appStatus = "testing";
      startSpinner(ctx.cwd, state, ctx.ui);
      ctx.ui.notify(`Testing ${state.activeScheme.name}${filterLabel}${planLabel} on ${destLabel}...`, "info");

      const signal = startOperation(state, `Test ${state.activeScheme.name}${filterLabel}${planLabel}`);
      try {
        const testExec = createTestExec(state);
        const result = await testExec("xcodebuild", testArgs, { signal, timeout: 1_200_000, cwd: xcodeArgs.execCwd });
        const combined = `${result.stdout}\n${result.stderr}`;
        const testResult = parseTestResult(combined);

        if (testResult.success) {
          ctx.ui.notify(`✅ All ${testResult.total} tests passed (${testResult.duration.toFixed(1)}s)`, "info");
        } else {
          // Show failed tests
          const failedCases = testResult.cases.filter((c) => !c.passed);
          const lines = [
            `❌ ${testResult.failed}/${testResult.total} tests failed (${testResult.duration.toFixed(1)}s)`,
          ];
          for (const tc of failedCases) {
            lines.push(`  ✗ ${tc.suite}.${tc.name}`);
            if (tc.failureMessage) {
              lines.push(`    ${tc.failureMessage}`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "error");
        }
      } finally {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
        updateStatusBar(ctx.cwd, state, ctx.ui);
      }
    },
  });

  // ── /stop command ─────────────────────────────────────────────────────
  pi.registerCommand("stop", {
    description: "Stop the currently running build, test, or run operation",
    handler: async (_args, ctx) => {
      const result = await stopActiveOperation(exec, ctx.cwd, state, ctx.ui);
      ctx.ui.notify(result.content[0].text, result.details.stopped ? "info" : "error");
    },
  });

  // ── Register tools (override built-in xcode tools) ────────────────────
  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    registerBuildTool(pi, exec, sessionCwd, state);
    registerRunTool(pi, exec, sessionCwd, state);
    registerTestTool(pi, exec, sessionCwd, state);
    registerStopTool(pi, exec, sessionCwd, state);

    // Replace built-in xcode tools with our versions
    const builtInXcodeTools = ["xcode_build", "xcode_clean", "xcode_discover", "xcode_run", "xcode_test", "xcode_stop"];
    const currentTools = pi.getActiveTools();
    const withoutBuiltIn = currentTools.filter((t) => !builtInXcodeTools.includes(t));
    pi.setActiveTools([...withoutBuiltIn, ...builtInXcodeTools]);

    // Auto-detect project → scheme → destination silently
    await autoDetect(exec, sessionCwd, state, ctx.ui);
  });
}
