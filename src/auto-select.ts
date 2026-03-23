/**
 * Pure heuristics for auto-selecting the best scheme, destination,
 * and extracting project base names.  No I/O, no state mutation.
 */

import nodePath from "node:path";
import type { Destination, XcodeScheme } from "./types.js";

/**
 * Pick the best scheme from a list.
 * Priority:
 *   1. App scheme whose name matches the project/workspace name
 *   2. Any app scheme (productType === "app")
 *   3. Extension schemes (also executable)
 *   4. Non-test, non-framework schemes (fallback heuristic by name)
 *   5. First scheme
 *
 * @param projectName - Optional project/workspace base name (e.g. "Letyco") for tiebreaking
 */
export function pickBestScheme(schemes: XcodeScheme[], projectName?: string): XcodeScheme | undefined {
  if (schemes.length === 0) return undefined;

  // 1. Prefer app schemes (identified from .xcscheme file)
  const appSchemes = schemes.filter((s) => s.productType === "app");
  if (appSchemes.length > 0) {
    // Among app schemes, prefer the one matching the project name
    if (projectName) {
      const matching = appSchemes.find((s) => s.name === projectName);
      if (matching) return matching;
    }
    return appSchemes[0];
  }

  // 2. Prefer extension schemes (also executable)
  const extSchemes = schemes.filter((s) => s.productType === "extension");
  if (extSchemes.length > 0) return extSchemes[0];

  // 3. Fallback: exclude test/framework by name when productType isn't known
  const nonTestNonFramework = schemes.filter((s) => {
    const lower = s.name.toLowerCase();
    return !lower.includes("test") && !lower.includes("framework");
  });
  if (nonTestNonFramework.length > 0) {
    // Among these, prefer matching project name
    if (projectName) {
      const matching = nonTestNonFramework.find((s) => s.name === projectName);
      if (matching) return matching;
    }
    return nonTestNonFramework[0];
  }

  // 4. Last resort
  return schemes[0];
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
 * Extract the base name from a project/workspace path.
 * e.g. "path/to/Letyco.xcworkspace" → "Letyco"
 *      "path/to/MyApp.xcodeproj" → "MyApp"
 *      "path/to/Package.swift" → "Package"
 */
export function projectBaseName(projectPath: string): string {
  const base = nodePath.basename(projectPath);
  // Strip .xcworkspace, .xcodeproj, .swift
  return base.replace(/\.(xcworkspace|xcodeproj|swift)$/, "");
}
