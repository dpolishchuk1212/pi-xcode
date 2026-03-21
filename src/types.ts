// ── Exec abstraction (injectable for testing) ──────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResult>;

// ── Discovery types ────────────────────────────────────────────────────────

export interface XcodeProject {
  path: string;
  type: "project" | "workspace" | "package";
}

export type SchemeProductType = "app" | "framework" | "test" | "extension" | "other";

export interface XcodeScheme {
  name: string;
  project: string;
  /** Product type inferred from the .xcscheme file (app, framework, test, etc.). */
  productType?: SchemeProductType;
}

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
}

export interface Destination {
  platform: string; // "iOS Simulator", "iOS", "macOS", "watchOS Simulator", etc.
  id: string; // UDID or placeholder
  name: string; // "iPhone 17", "Any iOS Device", "My Mac", etc.
  os?: string; // "26.1"
  arch?: string; // "arm64"
  variant?: string; // "Designed for [iPad,iPhone]", "Mac Catalyst"
}

export interface DiscoveryResult {
  projects: XcodeProject[];
  schemes: XcodeScheme[];
  simulators: Simulator[];
}

// ── Build types ────────────────────────────────────────────────────────────

export interface BuildIssue {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "note";
  message: string;
}

export interface BuildResult {
  success: boolean;
  issues: BuildIssue[];
  rawOutput: string;
}

// ── Test types ─────────────────────────────────────────────────────────────

export interface TestCase {
  suite: string;
  name: string;
  passed: boolean;
  duration: number;
  failureMessage?: string;
}

export interface TestResult {
  success: boolean;
  passed: number;
  failed: number;
  total: number;
  duration: number;
  cases: TestCase[];
  rawOutput: string;
}
