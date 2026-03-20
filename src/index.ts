import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import nodePath from "node:path";
import type { ExecFn } from "./types.js";
import { createState } from "./state.js";
import { discoverProjects, discoverSchemes, discoverSimulators } from "./discovery.js";
import { autoDetect, discoverAndSelect, updateProjectStatus } from "./resolve.js";
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

  // ── /project command ─────────────────────────────────────────────────
  pi.registerCommand("project", {
    description: "Select the active Xcode project, workspace, or Swift package for builds",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const projects = await discoverProjects(exec, cwd, 6);

      if (projects.length === 0) {
        ctx.ui.notify("No Xcode projects, workspaces, or Package.swift found.", "error");
        return;
      }

      const theme = ctx.ui.theme;

      // ── Project selection ────────────────────────────────────────────
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

      // ── Scheme selection ─────────────────────────────────────────────
      const schemes = await discoverSchemes(exec, selectedProject.path);

      let selectedScheme = schemes[0]; // fallback
      if (schemes.length > 1) {
        const formatScheme = (s: (typeof schemes)[number]) => {
          let label = s.name;
          if (state.activeScheme?.name === s.name && state.activeProject?.path === selectedProject.path) {
            label += theme.fg("accent", " ★ active");
          }
          return label;
        };

        const schemeOptions = schemes.map(formatScheme);
        const schemeChoice = await ctx.ui.select("Select a scheme:", schemeOptions);
        if (schemeChoice === undefined) return;

        const schemeIdx = schemeOptions.indexOf(schemeChoice);
        selectedScheme = schemeIdx >= 0 ? schemes[schemeIdx] : undefined;
      }

      // ── Save to state ────────────────────────────────────────────────
      state.activeProject = selectedProject;
      state.activeScheme = selectedScheme;

      updateProjectStatus(cwd, state, ctx.ui);

      const relativePath = nodePath.relative(cwd, selectedProject.path) || selectedProject.path;
      const schemeInfo = selectedScheme ? ` (scheme: ${selectedScheme.name})` : "";
      ctx.ui.notify(`Active project: ${relativePath}${schemeInfo}`, "info");
    },
  });

  // ── /simulator command ───────────────────────────────────────────────
  pi.registerCommand("simulator", {
    description: "Select the active iOS Simulator for builds and runs",
    handler: async (_args, ctx) => {
      const simulators = await discoverSimulators(exec);
      const iosDevices = simulators.filter(
        (s) => s.name.startsWith("iPhone") || s.name.startsWith("iPad"),
      );

      if (iosDevices.length === 0) {
        ctx.ui.notify("No iOS simulators found.", "error");
        return;
      }

      const theme = ctx.ui.theme;
      const formatOption = (s: typeof iosDevices[number]) => {
        let label = `${s.name} (${s.runtime})`;
        if (s.state === "Booted") label += theme.fg("success", " ▶ booted");
        if (state.activeSimulator?.udid === s.udid) label += theme.fg("accent", " ★ active");
        label += " " + theme.fg("dim", s.udid);
        return label;
      };

      const options = iosDevices.map(formatOption);

      const choice = await ctx.ui.select("Select active simulator:", options);
      if (choice === undefined) return;

      const selectedIndex = options.indexOf(choice);
      const selected = selectedIndex >= 0 ? iosDevices[selectedIndex] : undefined;

      if (selected) {
        state.activeSimulator = selected;
        ctx.ui.setStatus("xcode", `📱 ${selected.name} (${selected.runtime})`);
        ctx.ui.notify(`Active simulator: ${selected.name} (${selected.runtime})`, "info");
      }
    },
  });

  // ── Register tools (override built-in xcode tools) ────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    registerBuildTool(pi, exec, cwd, state);
    registerCleanTool(pi, exec, cwd, state);
    registerDiscoverTool(pi, exec, cwd);
    registerRunTool(pi, exec, cwd, state);
    registerTestTool(pi, exec, cwd, state);
    registerProfileTool(pi, exec, cwd, state);

    // Replace built-in xcode tools with our versions that support active simulator
    const builtInXcodeTools = ["xcode_build", "xcode_clean", "xcode_discover", "xcode_run", "xcode_test", "xcode_profile"];
    const currentTools = pi.getActiveTools();
    const withoutBuiltIn = currentTools.filter((t) => !builtInXcodeTools.includes(t));
    pi.setActiveTools([...withoutBuiltIn, ...builtInXcodeTools]);

    // Auto-detect project and simulator silently
    await autoDetect(exec, cwd, state, ctx.ui);
  });
}
