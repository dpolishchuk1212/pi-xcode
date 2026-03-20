/**
 * Auto-discover Xcode projects, workspaces, schemes, and simulators.
 */

import type { DiscoveryResult, ExecFn, Simulator, XcodeProject, XcodeScheme } from "./types.js";
import { buildListArgs, buildSimctlListArgs } from "./commands.js";
import { parseSchemeList, parseSimulatorList } from "./parsers.js";

/**
 * Find .xcodeproj and .xcworkspace files in `cwd`.
 * @param maxDepth - how deep to search (default: 1 = top-level only)
 */
export async function discoverProjects(exec: ExecFn, cwd: string, maxDepth: number = 1): Promise<XcodeProject[]> {
  const result = await exec(
    "find",
    [cwd, "-maxdepth", String(maxDepth), "(", "-name", "*.xcodeproj", "-o", "-name", "*.xcworkspace", ")"],
    { timeout: 10000 },
  );

  if (result.code !== 0) return [];

  const projects: XcodeProject[] = [];

  for (const line of result.stdout.split("\n")) {
    const path = line.trim();
    if (!path) continue;

    // Skip Pods workspace, SPM internal workspaces, nested xcodeproj inside xcodeproj
    if (path.includes("/Pods/") || path.includes(".swiftpm/")) continue;
    if (path.includes(".xcodeproj/")) continue;

    if (path.endsWith(".xcworkspace")) {
      projects.push({ path, type: "workspace" });
    } else if (path.endsWith(".xcodeproj")) {
      projects.push({ path, type: "project" });
    }
  }

  // Prefer workspaces over projects (workspace includes pod/SPM deps)
  projects.sort((a, b) => {
    if (a.type === "workspace" && b.type !== "workspace") return -1;
    if (b.type === "workspace" && a.type !== "workspace") return 1;
    return a.path.localeCompare(b.path);
  });

  return projects;
}

/**
 * Discover schemes for a given project or workspace.
 */
export async function discoverSchemes(exec: ExecFn, projectPath: string): Promise<XcodeScheme[]> {
  const args = buildListArgs(projectPath);
  const result = await exec("xcodebuild", args, { timeout: 15000 });

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
