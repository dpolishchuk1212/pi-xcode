/**
 * Platform-specific helpers for running apps on different destinations.
 * Handles simulator (simctl), physical device (devicectl), and macOS (open).
 */

import nodePath from "node:path";
import { createLogger } from "./log.js";
import type { Destination, ExecFn } from "./types.js";

const debug = createLogger("runner");

// ── Destination classification ─────────────────────────────────────────────

export type DestinationType = "simulator" | "device" | "mac";

/**
 * Classify a destination by how we install/launch apps on it.
 */
export function classifyDestination(dest: Destination): DestinationType {
  if (dest.platform.includes("Simulator")) return "simulator";
  if (dest.platform === "macOS" || dest.variant?.includes("Catalyst")) return "mac";
  return "device"; // iOS, watchOS, tvOS physical devices
}

// ── Terminate ──────────────────────────────────────────────────────────────

/**
 * Terminate a running app instance. Errors are silently ignored
 * (app might not be running).
 */
export async function terminateApp(
  exec: ExecFn,
  dest: Destination,
  bundleId: string,
  _appPath?: string,
): Promise<void> {
  const type = classifyDestination(dest);
  debug("terminateApp bundleId:", bundleId, "type:", type, "destId:", dest.id);

  try {
    switch (type) {
      case "simulator":
        debug("simctl terminate", dest.id, bundleId);
        await exec("xcrun", ["simctl", "terminate", dest.id, bundleId], { timeout: 10_000 });
        break;

      case "mac": {
        debug("osascript quit", bundleId);
        // Use AppleScript to quit by bundle ID — works for any macOS app
        await exec("osascript", ["-e", `tell application id "${bundleId}" to quit`], { timeout: 5_000 });
        // Give it a moment to shut down
        await new Promise((r) => setTimeout(r, 500));
        break;
      }

      case "device":
        debug("device terminate skipped (devicectl replaces on launch)");
        // devicectl doesn't have a clean terminate-by-bundleId;
        // the new launch will replace the existing instance
        break;
    }
    debug("terminateApp completed");
  } catch {
    debug("terminateApp ignored error (app might not be running)");
    // Ignore — app might not be running
  }
}

// ── Boot / prepare destination ─────────────────────────────────────────────

/**
 * Ensure the destination is ready to receive apps.
 * For simulators: boot if needed and open Simulator.app.
 * For devices/Mac: no-op.
 */
export async function ensureDestinationReady(exec: ExecFn, dest: Destination): Promise<void> {
  if (classifyDestination(dest) !== "simulator") {
    debug("ensureDestinationReady: skipped (not simulator)");
    return;
  }

  // Try to boot — simctl returns non-zero if already booted, which we ignore
  debug("booting simulator:", dest.id, dest.name);
  try {
    await exec("xcrun", ["simctl", "boot", dest.id], { timeout: 30_000 });
    debug("simulator booted");
  } catch {
    debug("simulator boot skipped (already booted or non-fatal error)");
    // Already booted or other non-fatal error
  }

  // Wait until the simulator runtime is fully ready (all system services started).
  // Without this, simctl install/launch can silently fail or the app can crash
  // because the runtime isn't ready to host apps yet.
  debug("waiting for simulator boot status:", dest.id);
  try {
    await exec("xcrun", ["simctl", "bootstatus", dest.id, "-b"], { timeout: 120_000 });
    debug("simulator fully booted");
  } catch {
    debug("bootstatus wait failed (proceeding anyway)");
  }

  // Open Simulator.app so the user can see it
  debug("opening Simulator.app");
  await exec("open", ["-a", "Simulator"], { timeout: 5_000 });
}

// ── Uninstall ──────────────────────────────────────────────────────────────

/**
 * Uninstall an app from the destination. Used as part of force-refresh retry
 * when a normal install+launch cycle fails. Errors are silently ignored
 * (app might not be installed).
 */
export async function uninstallApp(
  exec: ExecFn,
  dest: Destination,
  bundleId: string,
): Promise<void> {
  const type = classifyDestination(dest);
  debug("uninstallApp bundleId:", bundleId, "type:", type, "destId:", dest.id);

  try {
    switch (type) {
      case "simulator":
        debug("simctl uninstall", dest.id, bundleId);
        await exec("xcrun", ["simctl", "uninstall", dest.id, bundleId], { timeout: 30_000 });
        debug("simctl uninstall completed");
        break;

      case "device":
        debug("devicectl uninstall", dest.id, bundleId);
        await exec("xcrun", ["devicectl", "device", "uninstall", "app", "--device", dest.id, bundleId], {
          timeout: 30_000,
        });
        debug("devicectl uninstall completed");
        break;

      case "mac":
        debug("mac uninstall skipped (runs from build dir)");
        break;
    }
  } catch {
    debug("uninstallApp ignored error (app might not be installed)");
  }
}

// ── Install ────────────────────────────────────────────────────────────────

/**
 * Install an app on the destination.
 * - Simulator: `simctl install`
 * - Device: `devicectl device install app`
 * - Mac: no install needed (app runs from build dir)
 */
export async function installApp(
  exec: ExecFn,
  dest: Destination,
  appPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const type = classifyDestination(dest);
  debug("installApp type:", type, "appPath:", appPath, "destId:", dest.id);

  switch (type) {
    case "simulator":
      debug("simctl install", dest.id, appPath);
      await exec("xcrun", ["simctl", "install", dest.id, appPath], { signal, timeout: 60_000 });
      debug("simctl install completed");
      break;

    case "device":
      debug("devicectl install", dest.id, appPath);
      await exec("xcrun", ["devicectl", "device", "install", "app", "--device", dest.id, appPath], {
        signal,
        timeout: 120_000,
      });
      debug("devicectl install completed");
      break;

    case "mac":
      debug("mac install skipped (runs from build dir)");
      // No install needed — app runs directly from build products
      break;
  }
}

// ── Launch ─────────────────────────────────────────────────────────────────

export interface LaunchResult {
  success: boolean;
  error?: string;
  /** PID of the launched process (when available). Used for lifecycle monitoring. */
  pid?: number;
}

/**
 * Launch an app on the destination. Returns the PID when possible.
 * - Simulator: `simctl launch` — PID parsed from stdout ("bundleId: PID")
 * - Device: `devicectl device process launch` — PID parsed if available
 * - Mac: `open <app-path>` — PID found via `pgrep`
 */
export async function launchApp(
  exec: ExecFn,
  dest: Destination,
  bundleId: string,
  appPath: string,
  signal?: AbortSignal,
): Promise<LaunchResult> {
  const type = classifyDestination(dest);
  debug("launchApp bundleId:", bundleId, "type:", type, "destId:", dest.id);

  try {
    switch (type) {
      case "simulator": {
        // Retry launch up to 3 times — the simulator runtime may not be fully
        // ready to host apps even after bootstatus reports booted (race with
        // SpringBoard / launchd_sim initialisation).
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          debug("simctl launch attempt", attempt, dest.id, bundleId);
          const result = await exec("xcrun", ["simctl", "launch", dest.id, bundleId], { signal, timeout: 30_000 });
          if (result.code !== 0) {
            debug("simctl launch failed (attempt", attempt, "):", result.stderr);
            if (attempt < maxAttempts) {
              debug("retrying after 2s...");
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }
            return { success: false, error: result.stderr };
          }

          // simctl launch prints "com.example.App: 12345"
          const pid = parsePidFromOutput(result.stdout);
          debug("simctl launch returned pid:", pid);

          // Verify the process is actually alive — simctl can return 0 + PID
          // even when the app crashes immediately on launch.
          if (pid) {
            await new Promise((r) => setTimeout(r, 500));
            const alive = await isProcessAlive(exec, pid);
            if (alive) {
              debug("post-launch verify: pid", pid, "is alive ✓");
              return { success: true, pid };
            }
            debug("post-launch verify: pid", pid, "died immediately (attempt", attempt, ")");
            if (attempt < maxAttempts) {
              debug("retrying after 2s...");
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }
            return { success: false, error: "App launched but crashed immediately" };
          }

          // No PID parsed — try fallback lookup
          debug("no PID from simctl output, attempting fallback pgrep");
          const fallbackPid = await findProcessPid(exec, nodePath.basename(appPath, ".app"));
          if (fallbackPid) {
            debug("fallback PID found:", fallbackPid);
            return { success: true, pid: fallbackPid };
          }

          // No PID at all — assume launch worked (simctl returned 0)
          debug("warning: no PID available, assuming launch succeeded");
          return { success: true, pid: undefined };
        }
        // Should not reach here, but satisfy TypeScript
        return { success: false, error: "Launch failed after retries" };
      }

      case "device": {
        debug("devicectl launch", dest.id, bundleId);
        const result = await exec(
          "xcrun",
          ["devicectl", "device", "process", "launch", "--device", dest.id, bundleId],
          { signal, timeout: 30_000 },
        );
        if (result.code !== 0) {
          debug("devicectl launch failed:", result.stderr);
          return { success: false, error: result.stderr };
        }
        // devicectl may print PID in output — best effort parse
        const pid = parsePidFromOutput(`${result.stdout}\n${result.stderr}`);
        debug("devicectl launch success, pid:", pid);
        return { success: true, pid };
      }

      case "mac": {
        debug("open", appPath);
        const result = await exec("open", [appPath], { signal, timeout: 10_000 });
        if (result.code !== 0) {
          debug("open failed:", result.stderr);
          return { success: false, error: result.stderr };
        }
        // Find PID via pgrep using the app's executable name
        const appName = nodePath.basename(appPath, ".app");
        const pid = await findProcessPid(exec, appName);
        debug("open success, pid:", pid);
        return { success: true, pid };
      }
    }
  } catch (e) {
    debug("launchApp error:", String(e));
    return { success: false, error: String(e) };
  }
}

// ── Process monitoring ─────────────────────────────────────────────────────

/**
 * Monitor a launched app process. Polls `ps -p <pid>` at a regular interval.
 * Calls `onExit` when the process is no longer running.
 * Returns a cleanup function to stop monitoring.
 */
export function monitorAppLifecycle(exec: ExecFn, pid: number, onExit: () => void, intervalMs = 1000): () => void {
  let stopped = false;

  debug("monitorAppLifecycle started for pid:", pid, "interval:", intervalMs, "ms");

  const check = async () => {
    if (stopped) return;
    const alive = await isProcessAlive(exec, pid);
    if (!alive && !stopped) {
      debug("monitorAppLifecycle: pid", pid, "exited");
      stopped = true;
      clearInterval(timer);
      onExit();
    }
  };

  const timer = setInterval(check, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Check if a process is still running using `ps -p <pid>`.
 * Works for both simulator (processes run on host) and macOS apps.
 */
export async function isProcessAlive(exec: ExecFn, pid: number): Promise<boolean> {
  try {
    const result = await exec("ps", ["-p", String(pid)], { timeout: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

// ── PID parsing helpers ────────────────────────────────────────────────────

/**
 * Parse a PID from command output. Looks for patterns like:
 * - "com.example.App: 12345" (simctl launch)
 * - "pid: 12345" or "PID: 12345" (devicectl)
 * - Any trailing number after a colon or equals
 */
export function parsePidFromOutput(output: string): number | undefined {
  // simctl format: "com.example.App: 12345"
  const colonMatch = output.match(/:\s*(\d+)\s*$/m);
  if (colonMatch) {
    const pid = parseInt(colonMatch[1], 10);
    if (!Number.isNaN(pid) && pid > 0) return pid;
  }

  // devicectl or other format: "pid" = 12345 or "PID: 12345"
  const pidMatch = output.match(/pid["\s:=]+(\d+)/i);
  if (pidMatch) {
    const pid = parseInt(pidMatch[1], 10);
    if (!Number.isNaN(pid) && pid > 0) return pid;
  }

  return undefined;
}

/**
 * Find a process PID by executable name using `pgrep -x`.
 * Returns the most recent PID (highest number) if multiple matches.
 */
async function findProcessPid(exec: ExecFn, processName: string): Promise<number | undefined> {
  try {
    // Short delay to let the process start
    await new Promise((r) => setTimeout(r, 300));
    const result = await exec("pgrep", ["-xn", processName], { timeout: 5_000 });
    if (result.code !== 0) return undefined;
    const pid = parseInt(result.stdout.trim(), 10);
    return !Number.isNaN(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format a destination type for display.
 */
export function destinationTypeLabel(dest: Destination): string {
  const type = classifyDestination(dest);
  switch (type) {
    case "simulator":
      return "Simulator";
    case "device":
      return "Device";
    case "mac":
      return "Mac";
  }
}
