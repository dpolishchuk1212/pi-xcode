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
  type: "project" | "workspace";
}

export interface XcodeScheme {
  name: string;
  project: string;
}

export interface Simulator {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
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


