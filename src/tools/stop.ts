import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../log.js";
import { classifyDestination } from "../runner.js";
import type { XcodeState } from "../state.js";
import type { StatusBarUI } from "../status-bar.js";
import { stopSpinner, updateStatusBar } from "../status-bar.js";
import type { ExecFn } from "../types.js";

const debug = createLogger("stop");

/**
 * Force-kill any running xcodebuild processes. Uses SIGKILL (-9) for immediate
 * termination — SIGTERM is not enough because xcodebuild may hang during cleanup,
 * and orphaned child processes (swift-frontend, clang) can keep pipes open.
 */
async function killXcodebuildProcesses(exec: ExecFn): Promise<void> {
  try {
    await exec("pkill", ["-9", "-f", "xcodebuild"], { timeout: 5_000 });
  } catch {
    // No xcodebuild processes running — that's fine
  }
}

export function registerStopTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_stop",
    label: "Xcode Stop",
    description:
      "Stop the currently running Xcode operation (build, test, or run). " +
      "Interrupts the active process and resets status to idle.",
    promptSnippet: "Stop the currently running Xcode build, test, or run operation",
    promptGuidelines: ["Use xcode_stop to interrupt any running xcode_build, xcode_test, or xcode_run operation."],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return await stopActiveOperation(exec, cwd, state, ctx.ui);
    },
  });
}

/**
 * Shared logic for stopping the active operation — used by both the tool and the command.
 */
export async function stopActiveOperation(
  exec: ExecFn,
  cwd: string,
  state: XcodeState,
  ui: StatusBarUI & { notify(msg: string, level: "info" | "warning" | "error"): void },
) {
  const operationLabel = state.activeOperationLabel;
  const hadActiveOperation = !!state.activeAbortController;
  const previousStatus = state.appStatus;
  debug(
    "stopping — status:",
    previousStatus,
    "operation:",
    operationLabel ?? "none",
    "hasAbortController:",
    hadActiveOperation,
  );

  // 1. Abort via AbortController (signals the exec calls)
  if (state.activeAbortController) {
    debug("aborting active controller");
    state.activeAbortController.abort();
    state.activeAbortController = undefined;
    state.activeOperationLabel = undefined;
  }

  // 2. Kill xcodebuild processes directly for immediate effect
  debug("killing xcodebuild processes");
  await killXcodebuildProcesses(exec);

  // 3. Stop app monitor if running
  if (state.stopAppMonitor) {
    state.stopAppMonitor();
    state.stopAppMonitor = undefined;
  }

  // 4. If app is running, terminate it on the destination
  if (previousStatus === "running" && state.activeDestination) {
    // Terminate all user apps on the simulator via simctl
    try {
      if (classifyDestination(state.activeDestination) === "simulator") {
        // "booted" terminates all apps; we use the destination ID
        await exec("xcrun", ["simctl", "terminate", state.activeDestination.id, "all"], { timeout: 5_000 });
      }
    } catch {
      // Ignore — app may already be stopped
    }
  }

  // 5. Stop spinner and reset status
  stopSpinner(state);
  state.appStatus = "idle";
  updateStatusBar(cwd, state, ui);

  // Determine what was stopped for the response message
  const stoppedSomething = hadActiveOperation || previousStatus !== "idle";
  debug("stopped:", stoppedSomething);

  if (stoppedSomething) {
    let label: string;
    if (hadActiveOperation) {
      label = operationLabel ?? "operation";
    } else {
      // No in-flight build/test, but app was running/building/testing
      const statusLabels: Record<string, string> = {
        running: "running app",
        building: "build",
        testing: "tests",
        cleaning: "clean",
      };
      label = statusLabels[previousStatus] ?? previousStatus;
    }
    const message = `🛑 Stopped: ${label}`;
    return {
      content: [{ type: "text" as const, text: message }],
      details: { stopped: true, operation: label },
    };
  } else {
    return {
      content: [{ type: "text" as const, text: "No active operation to stop." }],
      details: { stopped: false },
    };
  }
}
