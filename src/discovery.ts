/**
 * Auto-discover Xcode projects, workspaces, schemes, and simulators.
 */

import nodePath from "node:path";
import { readFile } from "node:fs/promises";
import type { Destination, DiscoveryResult, ExecFn, SchemeProductType, Simulator, XcodeProject, XcodeScheme } from "./types.js";
import { buildListArgs, buildShowDestinationsArgs, buildSimctlListArgs } from "./commands.js";
import { parseConfigurationList, parseDestinations, parseSchemeList, parseSimulatorList } from "./parsers.js";

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
 * Enriches each scheme with its product type (app, framework, test, etc.)
 * by reading the .xcscheme files.
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
  const schemes = parseSchemeList(combined, projectPath);

  // Enrich schemes with product type from .xcscheme files
  await enrichSchemesWithProductType(schemes, projectPath);

  return schemes;
}

// ── Scheme product type detection ──────────────────────────────────────────

/**
 * Infer the product type from an .xcscheme file's BuildableName.
 *   - `.app` → "app"
 *   - `.framework` → "framework"
 *   - `.xctest` → "test"
 *   - `.appex` → "extension"
 *   - anything else → "other"
 */
export function inferProductType(buildableName: string): SchemeProductType {
  if (buildableName.endsWith(".app")) return "app";
  if (buildableName.endsWith(".framework")) return "framework";
  if (buildableName.endsWith(".xctest")) return "test";
  if (buildableName.endsWith(".appex")) return "extension";
  return "other";
}

/**
 * Read an .xcscheme file and extract the BuildableName from the primary
 * BuildActionEntry. Returns the inferred product type, or undefined if
 * the file can't be read or parsed.
 */
export async function readSchemeProductType(schemePath: string): Promise<SchemeProductType | undefined> {
  try {
    const xml = await readFile(schemePath, "utf-8");

    // Look for BuildableName in the first BuildActionEntry's BuildableReference.
    // This is the primary build product.
    const match = xml.match(/<BuildActionEntry[^>]*buildForRunning\s*=\s*"YES"[\s\S]*?BuildableName\s*=\s*"([^"]+)"/);
    if (match) {
      return inferProductType(match[1]);
    }

    // Fallback: any BuildableName in a BuildActionEntry
    const fallback = xml.match(/<BuildActionEntry[\s\S]*?BuildableName\s*=\s*"([^"]+)"/);
    if (fallback) {
      return inferProductType(fallback[1]);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enrich a list of schemes with product type info by reading their .xcscheme files.
 *
 * For workspaces, schemes typically live inside contained .xcodeproj bundles,
 * so we search both the workspace and sibling .xcodeproj scheme directories.
 */
async function enrichSchemesWithProductType(schemes: XcodeScheme[], projectPath: string): Promise<void> {
  if (projectPath.endsWith("Package.swift")) return; // SPM packages don't have .xcscheme files

  const schemeDirs = await collectSchemeDirs(projectPath);
  if (schemeDirs.length === 0) return;

  await Promise.all(
    schemes.map(async (scheme) => {
      for (const dir of schemeDirs) {
        const schemePath = nodePath.join(dir, `${scheme.name}.xcscheme`);
        const productType = await readSchemeProductType(schemePath);
        if (productType) {
          scheme.productType = productType;
          return;
        }
      }
    }),
  );
}

/**
 * Collect all scheme directories to search for .xcscheme files.
 *
 * For .xcodeproj: just its own xcshareddata/xcschemes/
 * For .xcworkspace: its own xcshareddata/xcschemes/ PLUS
 *   all .xcodeproj/xcshareddata/xcschemes/ in the same directory
 *   (workspaces contain schemes from their referenced projects)
 */
async function collectSchemeDirs(projectPath: string): Promise<string[]> {
  const dirs: string[] = [];

  // Always include the project/workspace's own scheme dir
  dirs.push(nodePath.join(projectPath, "xcshareddata", "xcschemes"));

  // For workspaces, also search sibling .xcodeproj scheme directories
  if (projectPath.endsWith(".xcworkspace")) {
    const parentDir = nodePath.dirname(projectPath);
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(parentDir);
      for (const entry of entries) {
        if (entry.endsWith(".xcodeproj")) {
          dirs.push(nodePath.join(parentDir, entry, "xcshareddata", "xcschemes"));
        }
      }
    } catch {
      // Directory read failed — continue with what we have
    }
  }

  return dirs;
}

/**
 * Discover build configurations for a given project, workspace, or Package.swift.
 * Parses "Build Configurations:" section from `xcodebuild -list`.
 */
export async function discoverConfigurations(exec: ExecFn, projectPath: string): Promise<string[]> {
  let args: string[];
  let execCwd: string | undefined;

  if (projectPath.endsWith("Package.swift")) {
    args = ["-list"];
    execCwd = nodePath.dirname(projectPath);
  } else {
    args = buildListArgs(projectPath);
  }

  const result = await exec("xcodebuild", args, { timeout: 15000, cwd: execCwd });

  const combined = result.stdout + "\n" + result.stderr;
  return parseConfigurationList(combined);
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
 * Prefers workspaces over projects, uses the best app scheme.
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

  // Derive project base name for tiebreaking (e.g. "Letyco.xcworkspace" → "Letyco")
  const baseName = nodePath.basename(project.path).replace(/\.(xcworkspace|xcodeproj|swift)$/, "");
  const schemes = discovery.schemes;

  // Prefer app schemes, with project-name match as tiebreaker
  const appSchemes = schemes.filter((s) => s.productType === "app");
  if (appSchemes.length > 0) {
    const matching = appSchemes.find((s) => s.name === baseName);
    return { project, scheme: matching ?? appSchemes[0] };
  }

  const extScheme = schemes.find((s) => s.productType === "extension");
  if (extScheme) return { project, scheme: extScheme };

  const nonTestNonFramework = schemes.filter((s) => {
    const lower = s.name.toLowerCase();
    return !lower.includes("test") && !lower.includes("framework");
  });
  if (nonTestNonFramework.length > 0) {
    const matching = nonTestNonFramework.find((s) => s.name === baseName);
    return { project, scheme: matching ?? nonTestNonFramework[0] };
  }

  return { project, scheme: schemes[0] };
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
