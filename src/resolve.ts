/**
 * Shared project/scheme/destination resolution logic used by all tools and commands.
 */

import nodePath from "node:path";
import type { Destination, XcodeProject, XcodeScheme, ExecFn } from "./types.js";
import type { XcodeState } from "./state.js";
import { discoverDestinations, discoverProjects, discoverSchemes } from "./discovery.js";

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
 * Also auto-selects scheme and destinations. Updates state and status bar.
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
 * then refresh destinations. Updates state.
 */
export async function refreshSchemes(
  exec: ExecFn,
  state: XcodeState,
  ui: Pick<ResolveUI, "setStatus" | "theme">,
): Promise<void> {
  if (!state.activeProject) {
    state.availableSchemes = [];
    state.activeScheme = undefined;
    state.availableDestinations = [];
    state.activeDestination = undefined;
    return;
  }

  const schemes = await discoverSchemes(exec, state.activeProject.path);
  state.availableSchemes = schemes;

  // Auto-select: prefer non-test scheme, then first
  const best = schemes.find((s) => !s.name.toLowerCase().includes("test")) ?? schemes[0];
  state.activeScheme = best;

  // Refresh destinations for the new scheme
  await refreshDestinations(exec, state, ui);
}

// ── Destination helpers ────────────────────────────────────────────────────

/**
 * Discover destinations for the active project/scheme and store them.
 * Auto-selects the best destination (prefer iPhone sim with latest OS).
 */
export async function refreshDestinations(
  exec: ExecFn,
  state: XcodeState,
  ui: Pick<ResolveUI, "setStatus" | "theme">,
): Promise<void> {
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
 * Pick the best destination from a list.
 * Prefers: iPhone simulator → iPad simulator → any simulator → first available.
 */
export function pickBestDestination(destinations: Destination[]): Destination | undefined {
  if (destinations.length === 0) return undefined;

  // Filter out placeholder destinations
  const real = destinations.filter((d) => !d.id.includes("placeholder"));
  if (real.length === 0) return destinations[0];

  // Prefer simulators (easier for dev)
  const sims = real.filter((d) => d.platform.includes("Simulator"));

  if (sims.length > 0) {
    // Prefer iPhones, then sort by OS descending (latest first)
    const iphones = sims.filter((d) => d.name.startsWith("iPhone"));
    if (iphones.length > 0) {
      return iphones.sort((a, b) => (b.os ?? "").localeCompare(a.os ?? ""))[0];
    }
    const ipads = sims.filter((d) => d.name.startsWith("iPad"));
    if (ipads.length > 0) {
      return ipads.sort((a, b) => (b.os ?? "").localeCompare(a.os ?? ""))[0];
    }
    return sims[0];
  }

  return real[0];
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

// ── Status bar ─────────────────────────────────────────────────────────────

/**
 * Update the unified status bar: `project | scheme | destination`
 * Styled to match the native pi footer (dim text).
 */
export function updateStatusBar(
  cwd: string,
  state: XcodeState,
  ui: Pick<ResolveUI, "setStatus" | "theme">,
): void {
  const { theme } = ui;
  const parts: string[] = [];

  if (state.activeProject) {
    const label = path.relative(cwd, state.activeProject.path) || state.activeProject.path;
    parts.push(theme.fg("dim", label));
  }

  if (state.activeScheme) {
    parts.push(theme.fg("dim", state.activeScheme.name));
  }

  if (state.activeDestination) {
    const d = state.activeDestination;
    const osLabel = d.os ? ` ${d.os}` : "";
    parts.push(theme.fg("dim", `${d.name}${osLabel}`));
  }

  if (parts.length === 0) {
    ui.setStatus("xcode", undefined);
  } else {
    const separator = theme.fg("dim", " · ");
    ui.setStatus("xcode", parts.join(separator));
  }
}

// ── Silent auto-detect (session start) ─────────────────────────────────────

/**
 * Silently auto-detect the best project, scheme, and destination at session start.
 * Picks the first match without prompting. Updates state and status bar.
 */
export async function autoDetect(
  exec: ExecFn,
  cwd: string,
  state: XcodeState,
  ui: Pick<ResolveUI, "setStatus" | "theme">,
): Promise<void> {
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

/** Re-export path utilities under a shorter alias. */
const path = nodePath;
