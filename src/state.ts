import type { Destination, XcodeProject, XcodeScheme } from "./types.js";

/**
 * Shared mutable state for the extension session.
 * Tools and commands read/write this to coordinate.
 */
export interface XcodeState {
  activeProject: XcodeProject | undefined;
  activeScheme: XcodeScheme | undefined;
  availableSchemes: XcodeScheme[];
  activeDestination: Destination | undefined;
  availableDestinations: Destination[];
  activeConfiguration: string | undefined;
  availableConfigurations: string[];
  appStatus: "idle" | "building" | "running" | "testing" | "profiling";
  /** Cleanup function to stop the current app lifecycle monitor. */
  stopAppMonitor: (() => void) | undefined;
  /** AbortController for the currently active operation (build/test/run/profile). */
  activeAbortController: AbortController | undefined;
  /** Label describing the currently active operation (for stop messages). */
  activeOperationLabel: string | undefined;
  /** Cleanup function to stop the status bar spinner animation. */
  stopSpinner: (() => void) | undefined;
  /** Timestamp when the current operation started (for elapsed time display). */
  operationStartTime: number | undefined;
  /** Number of completed build tasks (for progress display). */
  completedTasks: number;
}

export function createState(): XcodeState {
  return {
    activeProject: undefined,
    activeScheme: undefined,
    availableSchemes: [],
    activeDestination: undefined,
    availableDestinations: [],
    activeConfiguration: undefined,
    availableConfigurations: [],
    appStatus: "idle",
    stopAppMonitor: undefined,
    activeAbortController: undefined,
    activeOperationLabel: undefined,
    stopSpinner: undefined,
    operationStartTime: undefined,
    completedTasks: 0,
  };
}

/**
 * Start tracking an active operation. Returns a combined AbortSignal that
 * fires when either the framework signal or our own abort controller fires.
 */
export function startOperation(state: XcodeState, label: string, frameworkSignal?: AbortSignal): AbortSignal {
  // Abort any existing operation first
  state.activeAbortController?.abort();

  const controller = new AbortController();
  state.activeAbortController = controller;
  state.activeOperationLabel = label;

  // Combine framework signal with our own controller
  if (frameworkSignal) {
    return AbortSignal.any([frameworkSignal, controller.signal]);
  }
  return controller.signal;
}

/**
 * Clear the active operation tracking (called when operation completes).
 */
export function clearOperation(state: XcodeState): void {
  state.activeAbortController = undefined;
  state.activeOperationLabel = undefined;
}
