/**
 * Status bar rendering and spinner animation.
 * Reads XcodeState to display project · scheme · config · destination · progress.
 */

import nodePath from "node:path";
import type { XcodeState } from "./state.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Minimal UI surface needed for status bar updates. */
export interface StatusBarUI {
  setStatus(key: string, value: string | undefined): void;
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  };
}

// ── Spinner ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIndex = 0;

/**
 * Start an animated spinner in the status bar. Updates every 100ms.
 * Returns a cleanup function to stop the spinner.
 */
export function startSpinner(cwd: string, state: XcodeState, ui: StatusBarUI): void {
  // Stop any existing spinner
  stopSpinner(state);

  state.operationStartTime = Date.now();
  state.completedTasks = 0;
  state.passedTests = 0;
  state.failedTests = 0;
  spinnerIndex = 0;

  const timer = setInterval(() => {
    spinnerIndex++;
    updateStatusBar(cwd, state, ui);
  }, 100);

  state.stopSpinner = () => {
    clearInterval(timer);
    state.stopSpinner = undefined;
    state.operationStartTime = undefined;
  };
}

/**
 * Stop the status bar spinner animation.
 */
export function stopSpinner(state: XcodeState): void {
  state.stopSpinner?.();
}

// ── Status bar ─────────────────────────────────────────────────────────────

/**
 * Update the unified status bar: `project · scheme · configuration · destination`
 * Styled to match the native pi footer (dim text).
 */
export function updateStatusBar(cwd: string, state: XcodeState, ui: StatusBarUI): void {
  const { theme } = ui;
  const parts: string[] = [];

  if (state.activeProject) {
    const label = nodePath.relative(cwd, state.activeProject.path) || state.activeProject.path;
    parts.push(theme.fg("dim", label));
  }

  if (state.activeScheme) {
    parts.push(theme.fg("dim", state.activeScheme.name));
  }

  if (state.activeConfiguration) {
    parts.push(theme.fg("dim", state.activeConfiguration));
  }

  if (state.activeDestination) {
    const d = state.activeDestination;
    const osLabel = d.os ? ` ${d.os}` : "";
    parts.push(theme.fg("dim", `${d.name}${osLabel}`));
  }

  if (state.appStatus !== "idle") {
    const statusConfig: Record<string, { color: string; label: string }> = {
      building: { color: "warning", label: "Building" },
      testing: { color: "warning", label: "Testing" },
      cleaning: { color: "warning", label: "Cleaning" },
      profiling: { color: "warning", label: "Profiling" },
      running: { color: "accent", label: "Running" },
    };
    const config = statusConfig[state.appStatus] ?? { color: "dim", label: state.appStatus };

    // Elapsed time and progress info
    let elapsed = "";
    if (state.operationStartTime && state.appStatus !== "running") {
      const seconds = Math.floor((Date.now() - state.operationStartTime) / 1000);

      let progress = "";
      if (state.appStatus === "testing") {
        const total = state.passedTests + state.failedTests;
        if (total > 0) {
          progress =
            state.failedTests > 0 ? ` [${state.passedTests}✓ ${state.failedTests}✗]` : ` [${state.passedTests}✓]`;
        }
      } else if (state.completedTasks > 0) {
        progress = ` [${state.completedTasks}]`;
      }

      elapsed = ` ${seconds}s${progress}`;
    }

    // Spinner frame (for non-idle, non-running states)
    const spinnerFrame =
      state.appStatus !== "running" ? `${SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]} ` : "▶ ";

    parts.push(theme.fg(config.color, `${spinnerFrame}${config.label}${elapsed}`));
  }

  if (parts.length === 0) {
    ui.setStatus("xcode", undefined);
  } else {
    const separator = theme.fg("dim", " · ");
    ui.setStatus("xcode", parts.join(separator));
  }
}
