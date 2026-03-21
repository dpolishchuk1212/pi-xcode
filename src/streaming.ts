/**
 * Streaming xcodebuild execution with real-time task counting.
 * Uses Node's child_process.spawn to parse output line-by-line.
 */

import { spawn } from "node:child_process";
import type { XcodeState } from "./state.js";
import type { ExecFn, ExecResult } from "./types.js";

/**
 * Create a promise that resolves when an AbortSignal fires.
 * Used to race against long-running exec calls so we can respond
 * immediately to cancellation even if the underlying process hangs.
 */
function onAbort(signal: AbortSignal): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    if (signal.aborted) {
      resolve({ stdout: "", stderr: "Aborted", code: 1, killed: true });
      return;
    }
    signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "Aborted", code: 1, killed: true }), {
      once: true,
    });
  });
}

/**
 * Regex matching xcodebuild task lines. Each match = one completed build step.
 * These lines start at column 0 with a known verb.
 */
const TASK_LINE_RE =
  /^(CompileSwift|CompileC|SwiftCompile|Ld|Link|MergeSwiftModule|PhaseScriptExecution|CopySwiftLibs|ProcessInfoPlistFile|CompileAssetCatalog|CompileStoryboard|CodeSign|Validate|CpResource|CpHeader|Copy|ProcessProductPackaging|ProcessProductPackagingDER|GenerateAssetSymbols|WriteAuxiliaryFile|RegisterExecutionPolicyException|CreateUniversalBinary|SwiftDriver|SwiftEmitModule|SwiftMergeGeneratedHeaders|EmitSwiftModule)\b/;

/**
 * Count completed build tasks from xcodebuild output.
 */
function countTasks(output: string): number {
  let count = 0;
  for (const line of output.split("\n")) {
    if (TASK_LINE_RE.test(line)) count++;
  }
  return count;
}

/**
 * Create an exec function with build task counting.
 *
 * - Without execFn: uses child_process.spawn for real-time streaming task counts
 * - With execFn: delegates to it and counts tasks from the final output (for testability)
 */
export function createBuildExec(state: XcodeState, execFn?: ExecFn) {
  return (
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
  ): Promise<ExecResult> => {
    state.completedTasks = 0;

    // If we have an injected exec (e.g. in tests/tools), use it with post-hoc counting
    if (execFn) {
      const execPromise = execFn(command, args, options).then(
        (result) => {
          const combined = `${result.stdout}\n${result.stderr}`;
          state.completedTasks = countTasks(combined);
          return result;
        },
        (error) => {
          return { stdout: "", stderr: String(error), code: 1, killed: false } as ExecResult;
        },
      );

      // Race with abort signal so stop resolves immediately even if
      // pi.exec doesn't handle AbortSignal or orphaned children keep pipes open.
      if (options?.signal) {
        return Promise.race([execPromise, onAbort(options.signal)]);
      }
      return execPromise;
    }

    // Real mode: spawn directly for real-time task counting
    return new Promise<ExecResult>((resolve) => {
      const proc = spawn(command, args, {
        cwd: options?.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;
      let settled = false;

      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Parse stdout line-by-line for task counting
      let stdoutBuffer = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (TASK_LINE_RE.test(line)) {
            state.completedTasks++;
          }
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;

        for (const line of text.split("\n")) {
          if (TASK_LINE_RE.test(line)) {
            state.completedTasks++;
          }
        }
      });

      proc.on("close", (code) => {
        if (stdoutBuffer && TASK_LINE_RE.test(stdoutBuffer)) {
          state.completedTasks++;
        }
        settle({ stdout, stderr, code: code ?? 1, killed });
      });

      proc.on("error", () => {
        settle({ stdout, stderr, code: 1, killed: false });
      });

      // Handle abort signal — kill process and settle immediately
      if (options?.signal) {
        if (options.signal.aborted) {
          proc.kill("SIGKILL");
          killed = true;
          settle({ stdout, stderr, code: 1, killed: true });
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            killed = true;
            proc.kill("SIGKILL");
            // Settle immediately — don't wait for `close` event which may
            // hang if orphaned child processes (swift-frontend, clang) keep pipes open.
            settle({ stdout, stderr, code: 1, killed: true });
          },
          { once: true },
        );
      }

      // Handle timeout
      if (options?.timeout) {
        setTimeout(() => {
          if (!settled) {
            killed = true;
            proc.kill("SIGKILL");
          }
        }, options.timeout);
      }
    });
  };
}

// ── Test progress counting ─────────────────────────────────────────────────

/**
 * Regex matching xcodebuild test result lines:
 *   Test case 'SomeTests/testFoo()' passed on '...' (0.001 seconds)
 *   Test case 'SomeTests/testBar()' failed on '...' (0.002 seconds)
 */
const TEST_PASSED_RE = /^Test case '.+' passed/;
const TEST_FAILED_RE = /^Test case '.+' failed/;

/**
 * Count passed/failed tests from xcodebuild output.
 */
function countTests(output: string): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const line of output.split("\n")) {
    if (TEST_PASSED_RE.test(line)) passed++;
    else if (TEST_FAILED_RE.test(line)) failed++;
  }
  return { passed, failed };
}

/**
 * Create an exec function with test progress counting.
 *
 * - Without execFn: uses child_process.spawn for real-time test counts
 * - With execFn: delegates to it and counts from the final output (for testability)
 */
export function createTestExec(state: XcodeState, execFn?: ExecFn) {
  return (
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
  ): Promise<ExecResult> => {
    state.passedTests = 0;
    state.failedTests = 0;

    // If we have an injected exec (e.g. in tests/tools), use it with post-hoc counting
    if (execFn) {
      const execPromise = execFn(command, args, options).then(
        (result) => {
          const combined = `${result.stdout}\n${result.stderr}`;
          const counts = countTests(combined);
          state.passedTests = counts.passed;
          state.failedTests = counts.failed;
          return result;
        },
        (error) => {
          // pi.exec may reject on non-zero exit — return a synthetic result
          return { stdout: "", stderr: String(error), code: 1, killed: false } as ExecResult;
        },
      );

      // Race with abort signal so stop resolves immediately
      if (options?.signal) {
        return Promise.race([execPromise, onAbort(options.signal)]);
      }
      return execPromise;
    }

    // Real mode: spawn directly for real-time counting
    return new Promise<ExecResult>((resolve) => {
      const proc = spawn(command, args, {
        cwd: options?.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;
      let settled = false;

      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const processLine = (line: string) => {
        if (TEST_PASSED_RE.test(line)) state.passedTests++;
        else if (TEST_FAILED_RE.test(line)) state.failedTests++;
      };

      let stdoutBuffer = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        for (const line of text.split("\n")) processLine(line);
      });

      proc.on("close", (code) => {
        if (stdoutBuffer) processLine(stdoutBuffer);
        settle({ stdout, stderr, code: code ?? 1, killed });
      });

      proc.on("error", () => {
        settle({ stdout, stderr, code: 1, killed: false });
      });

      if (options?.signal) {
        if (options.signal.aborted) {
          proc.kill("SIGKILL");
          killed = true;
          settle({ stdout, stderr, code: 1, killed: true });
          return;
        }
        options.signal.addEventListener(
          "abort",
          () => {
            killed = true;
            proc.kill("SIGKILL");
            settle({ stdout, stderr, code: 1, killed: true });
          },
          { once: true },
        );
      }

      if (options?.timeout) {
        setTimeout(() => {
          if (!settled) {
            killed = true;
            proc.kill("SIGKILL");
          }
        }, options.timeout);
      }
    });
  };
}
