/**
 * Platform-specific helpers for running apps on different destinations.
 * Handles simulator (simctl), physical device (devicectl), and macOS (open).
 */

import nodePath from "node:path";
import type { Destination, ExecFn } from "./types.js";

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
  appPath?: string,
): Promise<void> {
  const type = classifyDestination(dest);

  try {
    switch (type) {
      case "simulator":
        await exec("xcrun", ["simctl", "terminate", dest.id, bundleId], { timeout: 10_000 });
        break;

      case "mac": {
        // Use AppleScript to quit by bundle ID — works for any macOS app
        await exec("osascript", ["-e", `tell application id "${bundleId}" to quit`], { timeout: 5_000 });
        // Give it a moment to shut down
        await new Promise((r) => setTimeout(r, 500));
        break;
      }

      case "device":
        // devicectl doesn't have a clean terminate-by-bundleId;
        // the new launch will replace the existing instance
        break;
    }
  } catch {
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
  if (classifyDestination(dest) !== "simulator") return;

  // Try to boot — simctl returns non-zero if already booted, which we ignore
  try {
    await exec("xcrun", ["simctl", "boot", dest.id], { timeout: 30_000 });
  } catch {
    // Already booted or other non-fatal error
  }

  // Open Simulator.app so the user can see it
  await exec("open", ["-a", "Simulator"], { timeout: 5_000 });
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

  switch (type) {
    case "simulator":
      await exec("xcrun", ["simctl", "install", dest.id, appPath], { signal, timeout: 60_000 });
      break;

    case "device":
      await exec(
        "xcrun",
        ["devicectl", "device", "install", "app", "--device", dest.id, appPath],
        { signal, timeout: 120_000 },
      );
      break;

    case "mac":
      // No install needed — app runs directly from build products
      break;
  }
}

// ── Launch ─────────────────────────────────────────────────────────────────

export interface LaunchResult {
  success: boolean;
  error?: string;
}

/**
 * Launch an app on the destination.
 * - Simulator: `simctl launch`
 * - Device: `devicectl device process launch`
 * - Mac: `open <app-path>`
 */
export async function launchApp(
  exec: ExecFn,
  dest: Destination,
  bundleId: string,
  appPath: string,
  signal?: AbortSignal,
): Promise<LaunchResult> {
  const type = classifyDestination(dest);

  try {
    switch (type) {
      case "simulator": {
        const result = await exec("xcrun", ["simctl", "launch", dest.id, bundleId], { signal, timeout: 30_000 });
        return { success: result.code === 0, error: result.code !== 0 ? result.stderr : undefined };
      }

      case "device": {
        const result = await exec(
          "xcrun",
          ["devicectl", "device", "process", "launch", "--device", dest.id, bundleId],
          { signal, timeout: 30_000 },
        );
        return { success: result.code === 0, error: result.code !== 0 ? result.stderr : undefined };
      }

      case "mac": {
        const result = await exec("open", [appPath], { signal, timeout: 10_000 });
        return { success: result.code === 0, error: result.code !== 0 ? result.stderr : undefined };
      }
    }
  } catch (e) {
    return { success: false, error: String(e) };
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
