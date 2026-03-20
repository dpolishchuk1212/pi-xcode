/**
 * Pure functions that build xcodebuild / simctl command arguments.
 * No I/O — easy to unit test.
 */

export interface XcodeBuildArgs {
  project?: string;
  workspace?: string;
  scheme?: string;
  configuration?: string;
  destination?: string;
  sdk?: string;
  extraArgs?: string[];
}

/**
 * Builds the base `xcodebuild` argument array from common options.
 */
export function buildBaseArgs(opts: XcodeBuildArgs): string[] {
  const args: string[] = [];

  if (opts.workspace) {
    args.push("-workspace", opts.workspace);
  } else if (opts.project) {
    args.push("-project", opts.project);
  }

  if (opts.scheme) {
    args.push("-scheme", opts.scheme);
  }

  if (opts.configuration) {
    args.push("-configuration", opts.configuration);
  }

  if (opts.destination) {
    args.push("-destination", opts.destination);
  }

  if (opts.sdk) {
    args.push("-sdk", opts.sdk);
  }

  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  return args;
}

/**
 * Build action arguments.
 */
export function buildBuildArgs(opts: XcodeBuildArgs): string[] {
  return [...buildBaseArgs(opts), "build"];
}

/**
 * Clean action arguments.
 */
export function buildCleanArgs(opts: XcodeBuildArgs): string[] {
  return [...buildBaseArgs(opts), "clean"];
}

/**
 * Test action arguments.
 */
export function buildTestArgs(
  opts: XcodeBuildArgs & { testPlan?: string; skipTesting?: string[]; onlyTesting?: string[] },
): string[] {
  const args = [...buildBaseArgs(opts), "test"];

  if (opts.testPlan) {
    args.push("-testPlan", opts.testPlan);
  }
  if (opts.onlyTesting) {
    for (const t of opts.onlyTesting) {
      args.push("-only-testing", t);
    }
  }
  if (opts.skipTesting) {
    for (const t of opts.skipTesting) {
      args.push("-skip-testing", t);
    }
  }

  return args;
}

/**
 * `-showBuildSettings` arguments (for extracting bundle ID, paths, etc.).
 */
export function buildShowSettingsArgs(opts: XcodeBuildArgs): string[] {
  return [...buildBaseArgs(opts), "-showBuildSettings"];
}

/**
 * `-list` arguments (for discovering schemes).
 */
export function buildListArgs(projectOrWorkspace: string): string[] {
  if (projectOrWorkspace.endsWith(".xcworkspace")) {
    return ["-list", "-workspace", projectOrWorkspace];
  }
  return ["-list", "-project", projectOrWorkspace];
}

/**
 * `xcrun simctl` arguments for listing available simulators.
 */
export function buildSimctlListArgs(): string[] {
  return ["simctl", "list", "devices", "available", "--json"];
}

/**
 * `xcrun simctl boot <udid>` arguments.
 */
export function buildSimctlBootArgs(udid: string): string[] {
  return ["simctl", "boot", udid];
}

/**
 * `xcrun simctl install <udid> <app-path>` arguments.
 */
export function buildSimctlInstallArgs(udid: string, appPath: string): string[] {
  return ["simctl", "install", udid, appPath];
}

/**
 * `xcrun simctl launch <udid> <bundle-id>` arguments.
 */
export function buildSimctlLaunchArgs(udid: string, bundleId: string, waitForDebugger?: boolean): string[] {
  const args = ["simctl", "launch"];
  if (waitForDebugger) {
    args.push("-w");
  }
  args.push(udid, bundleId);
  return args;
}

/**
 * `xcrun xctrace record` arguments for profiling.
 */
export function buildXctraceArgs(opts: {
  template: string;
  device?: string;
  appPath: string;
  outputDir?: string;
  timeLimit?: number;
}): string[] {
  const args = ["xctrace", "record", "--template", opts.template];

  if (opts.device) {
    args.push("--device", opts.device);
  }

  if (opts.outputDir) {
    args.push("--output", opts.outputDir);
  }

  if (opts.timeLimit) {
    args.push("--time-limit", `${opts.timeLimit}s`);
  }

  args.push("--launch", "--", opts.appPath);

  return args;
}

/**
 * Build the destination string for a simulator.
 */
export function buildSimulatorDestination(simulator: string): string {
  // If it looks like a UDID, use id=
  if (/^[0-9A-F-]{36}$/i.test(simulator)) {
    return `platform=iOS Simulator,id=${simulator}`;
  }
  return `platform=iOS Simulator,name=${simulator}`;
}
