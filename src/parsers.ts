import type { BuildIssue, BuildResult, Simulator, TestCase, TestResult, XcodeScheme } from "./types.js";

// ── Build output parsing ───────────────────────────────────────────────────

/**
 * Regex for xcodebuild diagnostic lines:
 *   /path/file.swift:10:5: error: something went wrong
 *   /path/file.m:20:3: warning: unused variable
 */
const ISSUE_RE = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/;

export function parseBuildIssues(output: string): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const seen = new Set<string>();

  for (const line of output.split("\n")) {
    const m = line.match(ISSUE_RE);
    if (!m) continue;

    const key = `${m[1]}:${m[2]}:${m[3]}:${m[4]}:${m[5]}`;
    if (seen.has(key)) continue;
    seen.add(key);

    issues.push({
      file: m[1],
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      severity: m[4] as BuildIssue["severity"],
      message: m[5],
    });
  }

  return issues;
}

export function parseBuildSuccess(output: string): boolean {
  return /\*\*\s*BUILD SUCCEEDED\s*\*\*/.test(output);
}

export function parseBuildResult(output: string): BuildResult {
  return {
    success: parseBuildSuccess(output),
    issues: parseBuildIssues(output),
    rawOutput: output,
  };
}

// ── Test output parsing ────────────────────────────────────────────────────

/**
 * Matches lines like:
 *   Test Case '-[MyTests testFoo]' passed (0.003 seconds).
 *   Test Case '-[MyTests testBar]' failed (0.012 seconds).
 *   Test Case 'MyTests.testFoo' passed (0.003 seconds).
 */
const TEST_CASE_RE =
  /Test Case '(?:-\[(\S+)\s+(\S+)\]|(\S+)\.(\S+))' (passed|failed) \((\d+\.\d+) seconds\)/;

/**
 * Matches the summary line:
 *   Executed 5 tests, with 1 failure (0 unexpected) in 0.123 (0.456) seconds
 */
const TEST_SUMMARY_RE =
  /Executed (\d+) tests?, with (\d+) failures? \(\d+ unexpected\) in (\d+\.\d+)/;

/**
 * Captures failure reason from lines like:
 *   /path/file.swift:42: error: -[Tests testFoo] : XCTAssertEqual failed: ("1") is not equal to ("2")
 */
const TEST_FAILURE_RE =
  /^.+:\d+: error: -\[(\S+)\s+(\S+)\]\s*:\s*(.+)$/;

export function parseTestCases(output: string): TestCase[] {
  const cases: TestCase[] = [];
  const failures = new Map<string, string>();

  // First pass: collect failure messages
  for (const line of output.split("\n")) {
    const fm = line.match(TEST_FAILURE_RE);
    if (fm) {
      failures.set(`${fm[1]}.${fm[2]}`, fm[3]);
    }
  }

  // Second pass: collect test cases
  for (const line of output.split("\n")) {
    const m = line.match(TEST_CASE_RE);
    if (!m) continue;

    const suite = m[1] ?? m[3];
    const name = m[2] ?? m[4];
    const passed = m[5] === "passed";
    const duration = parseFloat(m[6]);

    cases.push({
      suite,
      name,
      passed,
      duration,
      failureMessage: failures.get(`${suite}.${name}`),
    });
  }

  return cases;
}

export function parseTestResult(output: string): TestResult {
  const cases = parseTestCases(output);
  const summaryMatch = output.match(TEST_SUMMARY_RE);

  const total = summaryMatch ? parseInt(summaryMatch[1], 10) : cases.length;
  const failed = summaryMatch ? parseInt(summaryMatch[2], 10) : cases.filter((c) => !c.passed).length;
  const duration = summaryMatch ? parseFloat(summaryMatch[3]) : cases.reduce((s, c) => s + c.duration, 0);

  return {
    success: failed === 0,
    passed: total - failed,
    failed,
    total,
    duration,
    cases,
    rawOutput: output,
  };
}

// ── Scheme list parsing ────────────────────────────────────────────────────

/**
 * Parses `xcodebuild -list` output. Example:
 *
 *   Information about project "Foo":
 *       Targets:
 *           Foo
 *       Build Configurations:
 *           Debug
 *           Release
 *       Schemes:
 *           Foo
 *           FooTests
 */
export function parseSchemeList(output: string, projectPath: string): XcodeScheme[] {
  const schemes: XcodeScheme[] = [];
  let inSchemes = false;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();

    if (/^\s*Schemes:\s*$/.test(line)) {
      inSchemes = true;
      continue;
    }

    if (inSchemes) {
      const trimmed = line.trim();
      if (trimmed === "" || /^\S/.test(line)) {
        // Blank line or non-indented line → end of schemes section
        break;
      }
      schemes.push({ name: trimmed, project: projectPath });
    }
  }

  return schemes;
}

// ── Simulator list parsing ─────────────────────────────────────────────────

/**
 * Parses JSON output of `xcrun simctl list devices available --json`.
 */
export function parseSimulatorList(jsonOutput: string): Simulator[] {
  const simulators: Simulator[] = [];

  let data: { devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable: boolean }>> };
  try {
    data = JSON.parse(jsonOutput);
  } catch {
    return simulators;
  }

  if (!data.devices) return simulators;

  for (const [runtime, devices] of Object.entries(data.devices)) {
    // runtime looks like "com.apple.CoreSimulator.SimRuntime.iOS-18-0"
    const runtimeName = runtime.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-/g, ".");

    for (const device of devices) {
      if (!device.isAvailable) continue;
      simulators.push({
        udid: device.udid,
        name: device.name,
        runtime: runtimeName,
        state: device.state,
        isAvailable: device.isAvailable,
      });
    }
  }

  return simulators;
}

// ── Bundle ID parsing ──────────────────────────────────────────────────────

/**
 * Extracts bundle identifier from `xcodebuild -showBuildSettings` output.
 */
export function parseBundleId(output: string): string | undefined {
  const m = output.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(\S+)/);
  return m?.[1];
}

/**
 * Extracts the built .app path from build output or build settings.
 */
export function parseAppPath(output: string): string | undefined {
  // From build settings: BUILT_PRODUCTS_DIR + FULL_PRODUCT_NAME
  const dirMatch = output.match(/BUILT_PRODUCTS_DIR\s*=\s*(.+)/);
  const nameMatch = output.match(/FULL_PRODUCT_NAME\s*=\s*(\S+)/);

  if (dirMatch && nameMatch) {
    return `${dirMatch[1].trim()}/${nameMatch[1].trim()}`;
  }

  return undefined;
}
