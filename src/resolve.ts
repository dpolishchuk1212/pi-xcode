/**
 * Shared project/scheme/destination resolution logic used by all tools and commands.
 */

import nodePath from "node:path";
import { pickBestDestination, pickBestScheme, projectBaseName } from "./auto-select.js";
import { discoverConfigurations, discoverDestinations, discoverProjects, discoverSchemes } from "./discovery.js";
import { createLogger } from "./log.js";
import { loadPersistedState, savePersistedState, snapshotState } from "./persist.js";
import type { XcodeState } from "./state.js";
import type { StatusBarUI } from "./status-bar.js";
import { updateStatusBar } from "./status-bar.js";
import type { Destination, ExecFn, XcodeProject } from "./types.js";

const debug = createLogger("resolve");

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
  debug("refreshSchemes found", schemes.length, "schemes:", schemes.map((s) => s.name).join(", "));

  // Auto-select: prefer app schemes matching project name, then any app, then non-test
  state.activeScheme = pickBestScheme(schemes, projectBaseName(state.activeProject.path));
  debug("auto-selected scheme:", state.activeScheme?.name ?? "none", "productType:", state.activeScheme?.productType);

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
  debug("refreshConfigurations found:", configs.join(", "));

  // Auto-select: prefer "Debug", then first
  const best = configs.find((c) => c === "Debug") ?? configs[0];
  state.activeConfiguration = best;
  debug("auto-selected configuration:", best);
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
  debug("refreshDestinations found", destinations.length, "destinations");

  // Auto-select best destination (caller may override with persisted choice)
  const best = pickBestDestination(destinations);
  state.activeDestination = best;
  debug("auto-selected destination:", best ? `${best.name} (${best.platform}, ${best.id})` : "none");
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
  // ── Load persisted state ─────────────────────────────────────────────
  const persisted = await loadPersistedState(cwd);

  // ── Project ──────────────────────────────────────────────────────────
  const projects = await discoverProjects(exec, cwd, 6);

  if (projects.length > 0) {
    // Restore persisted project if still available, otherwise pick first
    const restoredProject = persisted.projectPath ? projects.find((p) => p.path === persisted.projectPath) : undefined;
    state.activeProject = restoredProject ?? projects[0];

    // ── Scheme → Destination (cascading) ─────────────────────────────
    await refreshSchemes(exec, state, ui);

    // ── Restore persisted scheme if still available ───────────────────
    if (persisted.schemeName) {
      const restoredScheme = state.availableSchemes.find((s) => s.name === persisted.schemeName);
      if (restoredScheme && restoredScheme.name !== state.activeScheme?.name) {
        debug("restoring persisted scheme:", restoredScheme.name);
        state.activeScheme = restoredScheme;
        // Re-refresh destinations for the restored scheme
        await refreshDestinations(exec, state, ui);
      }
    }

    // ── Restore persisted destination if still available ──────────────
    if (persisted.destinationId) {
      const restoredDest = state.availableDestinations.find((d) => d.id === persisted.destinationId);
      if (restoredDest) {
        debug("restoring persisted destination:", restoredDest.name, restoredDest.id);
        state.activeDestination = restoredDest;
      }
    }

    // ── Restore persisted configuration if still available ────────────
    if (persisted.configuration) {
      if (state.availableConfigurations.includes(persisted.configuration)) {
        debug("restoring persisted configuration:", persisted.configuration);
        state.activeConfiguration = persisted.configuration;
      }
    }
  }

  // ── Update unified status bar ────────────────────────────────────────
  updateStatusBar(cwd, state, ui);
}

// ── Persist current selections ─────────────────────────────────────────────

/**
 * Save current selections to disk so they survive across sessions.
 */
export async function persistSelections(cwd: string, state: XcodeState): Promise<void> {
  await savePersistedState(cwd, snapshotState(state));
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
