/**
 * Auto-discover Xcode projects, workspaces, schemes, and simulators.
 */

import nodePath from "node:path";
import type { Destination, DiscoveryResult, ExecFn, Simulator, XcodeProject, XcodeScheme } from "./types.js";
import { buildListArgs, buildShowDestinationsArgs, buildSimctlListArgs } from "./commands.js";
import { parseDestinations, parseSchemeList, parseSimulatorList } from "./parsers.js";

/**
 * Find .xcodeproj, .xcworkspace, and Package.swift files in `cwd`.
 * @param maxDepth - how deep to search (default: 1 = top-level only)
 */
export async function discoverProjects(exec: ExecFn, cwd: string, maxDepth: number = 1): Promise<XcodeProject[]> {
  const result = await exec(
    "find",
    [
      cwd,
      "-maxdepth",
      String(maxDepth),
      "(",
      "-name",
      "*.xcodeproj",
      "-o",
      "-name",
      "*.xcworkspace",
      "-o",
      "-name",
      "Package.swift",
      ")",
      "-not",
      "-path",
      "*/Pods/*",
      "-not",
      "-path",
      "*/.swiftpm/*",
      "-not",
      "-path",
      "*/.build/*",
    ],
    { timeout: 10000 },
  );

  if (result.code !== 0) return [];

  const projects: XcodeProject[] = [];

  for (const line of result.stdout.split("\n")) {
    const p = line.trim();
    if (!p) continue;

    // Skip Pods workspace, SPM internal workspaces, nested xcodeproj inside xcodeproj, build dirs
    if (p.includes("/Pods/") || p.includes(".swiftpm/") || p.includes("/.build/")) continue;
    if (p.includes(".xcodeproj/")) continue;

    if (p.endsWith(".xcworkspace")) {
      projects.push({ path: p, type: "workspace" });
    } else if (p.endsWith(".xcodeproj")) {
      projects.push({ path: p, type: "project" });
    } else if (p.endsWith("Package.swift")) {
      projects.push({ path: p, type: "package" });
    }
  }

  // Prefer: workspace > project > package
  const typeOrder: Record<XcodeProject["type"], number> = { workspace: 0, project: 1, package: 2 };
  projects.sort((a, b) => {
    const orderDiff = typeOrder[a.type] - typeOrder[b.type];
    if (orderDiff !== 0) return orderDiff;
    return a.path.localeCompare(b.path);
  });

  return projects;
}

/**
 * Discover schemes for a given project, workspace, or Package.swift.
 */
export async function discoverSchemes(exec: ExecFn, projectPath: string): Promise<XcodeScheme[]> {
  let args: string[];
  let execCwd: string | undefined;

  if (projectPath.endsWith("Package.swift")) {
    // For Package.swift, run `xcodebuild -list` from the package directory
    args = ["-list"];
    execCwd = nodePath.dirname(projectPath);
  } else {
    args = buildListArgs(projectPath);
  }

  const result = await exec("xcodebuild", args, { timeout: 15000, cwd: execCwd });

  const combined = result.stdout + "\n" + result.stderr;
  return parseSchemeList(combined, projectPath);
}

/**
 * Discover available simulators.
 */
export async function discoverSimulators(exec: ExecFn): Promise<Simulator[]> {
  const args = buildSimctlListArgs();
  const result = await exec("xcrun", args, { timeout: 10000 });

  if (result.code !== 0) return [];
  return parseSimulatorList(result.stdout);
}

/**
 * Discover available destinations for a project/workspace + scheme.
 * Runs `xcodebuild -showdestinations`.
 */
export async function discoverDestinations(
  exec: ExecFn,
  project: XcodeProject,
  schemeName: string,
): Promise<Destination[]> {
  let args: string[];
  let execCwd: string | undefined;

  if (project.type === "package") {
    args = buildShowDestinationsArgs({ scheme: schemeName });
    execCwd = nodePath.dirname(project.path);
  } else {
    const flag = project.type === "workspace" ? "workspace" : "project";
    args = buildShowDestinationsArgs({ [flag]: project.path, scheme: schemeName });
  }

  const result = await exec("xcodebuild", args, { timeout: 30_000, cwd: execCwd });

  // Parse regardless of exit code — xcodebuild may print destinations even on non-zero exit
  const combined = result.stdout + "\n" + result.stderr;
  return parseDestinations(combined);
}

/**
 * Full discovery: projects → schemes → simulators.
 */
export async function discover(exec: ExecFn, cwd: string): Promise<DiscoveryResult> {
  const [projects, simulators] = await Promise.all([discoverProjects(exec, cwd), discoverSimulators(exec)]);

  const schemes: XcodeScheme[] = [];
  for (const project of projects) {
    const projectSchemes = await discoverSchemes(exec, project.path);
    schemes.push(...projectSchemes);
  }

  return { projects, schemes, simulators };
}

/**
 * Auto-select the best project/workspace and scheme for a build.
 * Prefers workspaces over projects, uses the first non-test scheme.
 */
export function autoSelect(
  discovery: DiscoveryResult,
  preferredScheme?: string,
): { project?: XcodeProject; scheme?: XcodeScheme } {
  const project = discovery.projects[0];
  if (!project) return {};

  if (preferredScheme) {
    const scheme = discovery.schemes.find((s) => s.name === preferredScheme);
    if (scheme) return { project, scheme };
  }

  // Prefer non-test schemes
  const mainScheme =
    discovery.schemes.find((s) => !s.name.toLowerCase().includes("test")) ?? discovery.schemes[0];

  return { project, scheme: mainScheme };
}

/**
 * Find a simulator by name or UDID. Prefers booted simulators.
 */
export function findSimulator(simulators: Simulator[], nameOrUdid?: string): Simulator | undefined {
  if (nameOrUdid) {
    // Exact UDID match
    const byUdid = simulators.find((s) => s.udid === nameOrUdid);
    if (byUdid) return byUdid;

    // Name match (prefer booted)
    const byName = simulators.filter((s) => s.name === nameOrUdid);
    return byName.find((s) => s.state === "Booted") ?? byName[0];
  }

  // Default: latest iPhone, prefer booted
  const iphones = simulators.filter((s) => s.name.startsWith("iPhone"));
  const booted = iphones.find((s) => s.state === "Booted");
  if (booted) return booted;

  // Sort by runtime descending to get latest
  return iphones.sort((a, b) => b.runtime.localeCompare(a.runtime))[0];
}
