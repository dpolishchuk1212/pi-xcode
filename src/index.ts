import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import nodePath from "node:path";
import type { ExecFn } from "./types.js";
import { createState } from "./state.js";
import { discoverProjects, discoverSchemes } from "./discovery.js";
import {
  autoDetect,
  discoverAndSelect,
  formatDestinationLabel,
  refreshDestinations,
  updateDestinationStatus,
  updateProjectStatus,
} from "./resolve.js";
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

      // Re-discover destinations for the new project/scheme
      await refreshDestinations(exec, state, ctx.ui);
    },
  });

  // ── /destination command ─────────────────────────────────────────────
  pi.registerCommand("destination", {
    description: "Select the run destination (simulator, device, or Mac) for builds and runs",
    handler: async (_args, ctx) => {
      if (!state.activeProject || !state.activeScheme) {
        ctx.ui.notify("No active project. Use /project first.", "error");
        return;
      }

      if (state.availableDestinations.length === 0) {
        ctx.ui.notify("No destinations available for this project.", "error");
        return;
      }

      const theme = ctx.ui.theme;

      // Group destinations by platform for display
      const destinations = state.availableDestinations.filter((d) => !d.id.includes("placeholder"));

      if (destinations.length === 0) {
        ctx.ui.notify("No concrete destinations available (only placeholders found).", "error");
        return;
      }

      const formatOption = (d: (typeof destinations)[number]) => {
        let label = formatDestinationLabel(d);
        if (state.activeDestination?.id === d.id) {
          label += theme.fg("accent", " ★ active");
        }
        label += " " + theme.fg("dim", `[${d.platform}]`);
        return label;
      };

      const options = destinations.map(formatOption);

      const choice = await ctx.ui.select("Select run destination:", options);
      if (choice === undefined) return;

      const selectedIndex = options.indexOf(choice);
      const selected = selectedIndex >= 0 ? destinations[selectedIndex] : undefined;

      if (selected) {
        state.activeDestination = selected;
        updateDestinationStatus(state, ctx.ui);
        ctx.ui.notify(`Run destination: ${formatDestinationLabel(selected)}`, "info");
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

    // Auto-detect project, scheme, and destination silently
    await autoDetect(exec, cwd, state, ctx.ui);
  });
}
