/**
 * Shared project/scheme resolution logic used by all tools and the /project command.
 */

import nodePath from "node:path";
import type { XcodeProject, XcodeScheme, ExecFn } from "./types.js";
import type { XcodeState } from "./state.js";
import { discoverProjects, discoverSchemes } from "./discovery.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedProject {
  project: XcodeProject;
  scheme: string | undefined;
}

/** Minimal UI surface needed by resolution logic. */
export interface ResolveUI {
  select(prompt: string, options: string[]): Promise<string | undefined>;
  setStatus(key: string, value: string | undefined): void;
  notify(msg: string, level: "info" | "warning" | "error"): void;
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve the active project and scheme for a tool invocation.
 *
 * Priority:
 *   1. Explicit tool params (project/workspace/scheme)
 *   2. Active state (set by /project or previous auto-detect)
 *   3. Auto-discover (depth 6, with UI prompts if ambiguous)
 */
export async function resolveProjectAndScheme(
  exec: ExecFn,
  cwd: string,
  state: XcodeState,
  ui: ResolveUI,
  explicitParams?: { project?: string; workspace?: string; scheme?: string },
): Promise<ResolvedProject> {
  // 1. Explicit params take priority
  if (explicitParams?.workspace || explicitParams?.project) {
    const projectPath = (explicitParams.workspace ?? explicitParams.project)!;
    const type = resolveProjectType(projectPath, !!explicitParams.workspace);

    let schemeName = explicitParams.scheme;
    if (!schemeName) {
      const schemes = await discoverSchemes(exec, projectPath);
      const main = schemes.find((s) => !s.name.toLowerCase().includes("test")) ?? schemes[0];
      schemeName = main?.name;
    }

    return { project: { path: projectPath, type }, scheme: schemeName };
  }

  // 2. Active state (honour explicit scheme override if provided)
  if (state.activeProject) {
    const schemeName = explicitParams?.scheme ?? state.activeScheme?.name;
    return { project: state.activeProject, scheme: schemeName };
  }

  // 3. Auto-discover
  return discoverAndSelect(exec, cwd, state, ui);
}

/**
 * Discover projects recursively (depth 6) and select one interactively.
 * Saves selection to state and updates the status bar.
 */
export async function discoverAndSelect(
  exec: ExecFn,
  cwd: string,
  state: XcodeState,
  ui: ResolveUI,
): Promise<ResolvedProject> {
  const projects = await discoverProjects(exec, cwd, 6);

  if (projects.length === 0) {
    throw new Error("No Xcode project, workspace, or Package.swift found in current directory or subdirectories.");
  }

  let selectedProject: XcodeProject;

  if (projects.length === 1) {
    selectedProject = projects[0];
  } else {
    const options = projects.map((p) => path.relative(cwd, p.path) || p.path);
    const choice = await ui.select("Select a project:", options);
    if (choice === undefined) {
      throw new Error("Cancelled — no project selected.");
    }
    const idx = options.indexOf(choice);
    selectedProject = projects[idx];
  }

  // Discover schemes for the selected project
  const selectedScheme = await selectScheme(exec, selectedProject.path, ui);

  // Save to state
  state.activeProject = selectedProject;
  state.activeScheme = selectedScheme;

  // Update status bar
  updateProjectStatus(cwd, state, ui);

  return { project: selectedProject, scheme: selectedScheme?.name };
}

/**
 * Discover schemes and select one. Auto-selects if there's only one non-test scheme.
 */
async function selectScheme(
  exec: ExecFn,
  projectPath: string,
  ui: ResolveUI,
): Promise<XcodeScheme | undefined> {
  const schemes = await discoverSchemes(exec, projectPath);

  if (schemes.length === 0) return undefined;
  if (schemes.length === 1) return schemes[0];

  // Try to auto-select the main (non-test) scheme
  const nonTest = schemes.filter((s) => !s.name.toLowerCase().includes("test"));
  if (nonTest.length === 1) return nonTest[0];

  // Multiple candidates — ask the user
  const options = schemes.map((s) => s.name);
  const choice = await ui.select("Select a scheme:", options);
  if (choice === undefined) {
    throw new Error("Cancelled — no scheme selected.");
  }
  return schemes.find((s) => s.name === choice);
}

// ── xcodebuild arg helpers ────────────────────────────────────────────────

/**
 * Get the xcodebuild project/workspace flags and optional cwd for a resolved project.
 * For Package.swift, returns no project/workspace flags and sets execCwd to the package dir.
 */
export function getXcodebuildProjectArgs(project: XcodeProject): {
  projectFlag: string | undefined;
  workspaceFlag: string | undefined;
  execCwd: string | undefined;
} {
  switch (project.type) {
    case "workspace":
      return { projectFlag: undefined, workspaceFlag: project.path, execCwd: undefined };
    case "project":
      return { projectFlag: project.path, workspaceFlag: undefined, execCwd: undefined };
    case "package":
      // Package.swift — run xcodebuild from the package directory, no -project/-workspace
      return { projectFlag: undefined, workspaceFlag: undefined, execCwd: nodePath.dirname(project.path) };
  }
}

// ── Status bar ─────────────────────────────────────────────────────────────

/**
 * Update the status bar with the active project info.
 */
export function updateProjectStatus(cwd: string, state: XcodeState, ui: ResolveUI): void {
  if (!state.activeProject) {
    ui.setStatus("xcode-project", undefined);
    return;
  }

  const label = path.relative(cwd, state.activeProject.path) || state.activeProject.path;

  const icon =
    state.activeProject.type === "workspace"
      ? "🗂️"
      : state.activeProject.type === "package"
        ? "📦"
        : "📁";

  ui.setStatus("xcode-project", `${icon} ${label}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveProjectType(projectPath: string, isWorkspace: boolean): XcodeProject["type"] {
  if (isWorkspace) return "workspace";
  if (projectPath.endsWith(".xcworkspace")) return "workspace";
  if (projectPath.endsWith("Package.swift")) return "package";
  return "project";
}

/** Re-export path utilities under a shorter alias. */
const path = nodePath;
