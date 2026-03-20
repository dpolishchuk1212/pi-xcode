/**
 * Shared project/scheme resolution logic used by all tools and the /project command.
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

// ── Destination helpers ────────────────────────────────────────────────────

/**
 * Discover destinations for the active project/scheme and store them.
 * Auto-selects the best destination (prefer booted iPhone sim, then latest iPhone sim).
 */
export async function refreshDestinations(
  exec: ExecFn,
  state: XcodeState,
  ui: Pick<ResolveUI, "setStatus">,
): Promise<void> {
  if (!state.activeProject || !state.activeScheme) {
    state.availableDestinations = [];
    state.activeDestination = undefined;
    ui.setStatus("xcode", undefined);
    return;
  }

  const destinations = await discoverDestinations(exec, state.activeProject, state.activeScheme.name);
  state.availableDestinations = destinations;

  // Auto-select best destination: prefer iPhone simulator, then iPad, then any simulator, then first
  const best = pickBestDestination(destinations);
  state.activeDestination = best;
  updateDestinationStatus(state, ui);
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
 * Update the status bar with the active destination.
 */
export function updateDestinationStatus(
  state: XcodeState,
  ui: Pick<ResolveUI, "setStatus">,
): void {
  if (!state.activeDestination) {
    ui.setStatus("xcode", undefined);
    return;
  }

  const d = state.activeDestination;
  const osLabel = d.os ? ` (${d.platform.replace(" Simulator", "")} ${d.os})` : "";
  ui.setStatus("xcode", `📱 ${d.name}${osLabel}`);
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
export async function autoDetect(
  exec: ExecFn,
  cwd: string,
  state: XcodeState,
  ui: Pick<ResolveUI, "setStatus">,
): Promise<void> {
  // ── Project & scheme ─────────────────────────────────────────────────
  const projects = await discoverProjects(exec, cwd, 6);

  if (projects.length > 0) {
    // Already sorted: workspace > project > package — pick first
    const selectedProject = projects[0];

    const schemes = await discoverSchemes(exec, selectedProject.path);
    const selectedScheme =
      schemes.find((s) => !s.name.toLowerCase().includes("test")) ?? schemes[0];

    state.activeProject = selectedProject;
    state.activeScheme = selectedScheme;
    updateProjectStatus(cwd, state, ui as ResolveUI);
  }

  // ── Destinations for selected project/scheme ─────────────────────────
  await refreshDestinations(exec, state, ui);
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
