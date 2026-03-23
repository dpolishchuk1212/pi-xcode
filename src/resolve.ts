/**
 * Shared project/scheme/destination resolution logic used by all tools and commands.
 */

import nodePath from "node:path";
import { pickBestDestination, pickBestScheme, projectBaseName } from "./auto-select.js";
import { discoverConfigurations, discoverDestinations, discoverProjects, discoverSchemes } from "./discovery.js";
import type { XcodeState } from "./state.js";
import type { StatusBarUI } from "./status-bar.js";
import { updateStatusBar } from "./status-bar.js";
import type { Destination, ExecFn, XcodeProject } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedProject {
  project: XcodeProject;
  scheme: string | undefined;
}

/** Theme subset needed for styled status bar text. */
export interface ResolveTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Minimal UI surface needed by resolution logic. */
export interface ResolveUI {
  select(prompt: string, options: string[]): Promise<string | undefined>;
  setStatus(key: string, value: string | undefined): void;
  notify(msg: string, level: "info" | "warning" | "error"): void;
  theme: ResolveTheme;
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
      schemeName = pickBestScheme(schemes, projectBaseName(projectPath))?.name;
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
 * Also auto-selects scheme and destinations. Updates state and status bar.
 */
async function discoverAndSelect(
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
    const options = projects.map((p) => nodePath.relative(cwd, p.path) || p.path);
    const choice = await ui.select("Select a project:", options);
    if (choice === undefined) {
      throw new Error("Cancelled — no project selected.");
    }
    const idx = options.indexOf(choice);
    selectedProject = projects[idx];
  }

  // Save project to state
  state.activeProject = selectedProject;

  // Auto-select scheme and destinations
  await refreshSchemes(exec, state, ui);

  // Update status bar
  updateStatusBar(cwd, state, ui);

  return { project: selectedProject, scheme: state.activeScheme?.name };
}

// ── Scheme helpers ─────────────────────────────────────────────────────────

/**
 * Discover schemes for the active project, auto-select the best one,
 * then refresh destinations and configurations. Updates state.
 */
export async function refreshSchemes(exec: ExecFn, state: XcodeState, ui: StatusBarUI): Promise<void> {
  if (!state.activeProject) {
    state.availableSchemes = [];
    state.activeScheme = undefined;
    state.availableDestinations = [];
    state.activeDestination = undefined;
    state.availableConfigurations = [];
    state.activeConfiguration = undefined;
    return;
  }

  const schemes = await discoverSchemes(exec, state.activeProject.path);
  state.availableSchemes = schemes;

  // Auto-select: prefer app schemes matching project name, then any app, then non-test
  state.activeScheme = pickBestScheme(schemes, projectBaseName(state.activeProject.path));

  // Refresh destinations and configurations in parallel
  await Promise.all([refreshDestinations(exec, state, ui), refreshConfigurations(exec, state)]);
}

// ── Configuration helpers ──────────────────────────────────────────────────

/**
 * Discover build configurations for the active project and auto-select.
 * Prefers "Debug", then first available.
 */
export async function refreshConfigurations(exec: ExecFn, state: XcodeState): Promise<void> {
  if (!state.activeProject) {
    state.availableConfigurations = [];
    state.activeConfiguration = undefined;
    return;
  }

  const configs = await discoverConfigurations(exec, state.activeProject.path);
  state.availableConfigurations = configs;

  // Auto-select: prefer "Debug", then first
  const best = configs.find((c) => c === "Debug") ?? configs[0];
  state.activeConfiguration = best;
}

// ── Destination helpers ────────────────────────────────────────────────────

/**
 * Discover destinations for the active project/scheme and store them.
 * Auto-selects the best destination (prefer iPhone sim with latest OS).
 */
export async function refreshDestinations(exec: ExecFn, state: XcodeState, _ui: StatusBarUI): Promise<void> {
  if (!state.activeProject || !state.activeScheme) {
    state.availableDestinations = [];
    state.activeDestination = undefined;
    return;
  }

  const destinations = await discoverDestinations(exec, state.activeProject, state.activeScheme.name);
  state.availableDestinations = destinations;

  // Auto-select best destination
  const best = pickBestDestination(destinations);
  state.activeDestination = best;
}

/**
 * Format a destination for display in a picker list.
 */
export function formatDestinationLabel(d: Destination): string {
  const parts = [d.name];
  if (d.os) parts.push(`(${d.os})`);
  if (d.variant) parts.push(`— ${d.variant}`);
  return parts.join(" ");
}

// ── Silent auto-detect (session start) ─────────────────────────────────────

/**
 * Silently auto-detect the best project, scheme, and destination at session start.
 * Picks the first match without prompting. Updates state and status bar.
 */
export async function autoDetect(exec: ExecFn, cwd: string, state: XcodeState, ui: StatusBarUI): Promise<void> {
  // ── Project ──────────────────────────────────────────────────────────
  const projects = await discoverProjects(exec, cwd, 6);

  if (projects.length > 0) {
    // Already sorted: workspace > project > package — pick first
    state.activeProject = projects[0];

    // ── Scheme → Destination (cascading) ─────────────────────────────
    await refreshSchemes(exec, state, ui);
  }

  // ── Update unified status bar ────────────────────────────────────────
  updateStatusBar(cwd, state, ui);
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
      return { projectFlag: undefined, workspaceFlag: undefined, execCwd: nodePath.dirname(project.path) };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveProjectType(projectPath: string, isWorkspace: boolean): XcodeProject["type"] {
  if (isWorkspace) return "workspace";
  if (projectPath.endsWith(".xcworkspace")) return "workspace";
  if (projectPath.endsWith("Package.swift")) return "package";
  return "project";
}
