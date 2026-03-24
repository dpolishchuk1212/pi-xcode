/**
 * Streaming xcodebuild execution with real-time progress counting.
 * Uses Node's child_process.spawn to parse output line-by-line.
 *
 * Both build-task counting and test-result counting share a single
 * generic factory (`createStreamingExec`) — only the per-line logic differs.
 */

import { spawn } from "node:child_process";
import { createLogger } from "./log.js";
import type { XcodeState } from "./state.js";
import type { ExecFn, ExecResult } from "./types.js";

const debug = createLogger("streaming");

// ── Abort helper ───────────────────────────────────────────────────────────

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

// ── Line matchers ──────────────────────────────────────────────────────────

/**
 * Regex matching xcodebuild task lines. Each match = one completed build step.
 * These lines start at column 0 with a known verb.
 */
const TASK_LINE_RE =
  /^(CompileSwift|CompileC|SwiftCompile|Ld|Link|MergeSwiftModule|PhaseScriptExecution|CopySwiftLibs|ProcessInfoPlistFile|CompileAssetCatalog|CompileStoryboard|CodeSign|Validate|CpResource|CpHeader|Copy|ProcessProductPackaging|ProcessProductPackagingDER|GenerateAssetSymbols|WriteAuxiliaryFile|RegisterExecutionPolicyException|CreateUniversalBinary|SwiftDriver|SwiftEmitModule|SwiftMergeGeneratedHeaders|EmitSwiftModule)\b/;

/**
 * Regexes matching xcodebuild test result lines:
 *   Test case 'SomeTests/testFoo()' passed on '...' (0.001 seconds)
 *   Test case 'SomeTests/testBar()' failed on '...' (0.002 seconds)
 */
const TEST_PASSED_RE = /^Test case '.+' passed/;
const TEST_FAILED_RE = /^Test case '.+' failed/;

// ── Generic streaming exec factory ─────────────────────────────────────────

interface StreamingConfig {
  /** Reset progress counters before execution starts. */
  init(): void;
  /** Process a single output line to update progress counters. */
  processLine(line: string): void;
}

/**
 * Generic factory for creating a streaming exec function.
 *
 * - Without execFn: uses child_process.spawn for real-time line-by-line progress
 * - With execFn: delegates to it and counts from the final output (for testability)
 *
 * The caller provides `init` (to reset counters) and `processLine` (to update
 * them on each output line). Everything else — spawning, buffering, abort,
 * timeout — is handled once here.
 */
function createStreamingExec(config: StreamingConfig, execFn?: ExecFn) {
  return (
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
  ): Promise<ExecResult> => {
    config.init();

    // ── Injected exec path (tools / tests): post-hoc counting ────────
    if (execFn) {
      const execPromise = execFn(command, args, options).then(
        (result) => {
          for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
            config.processLine(line);
          }
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

    // ── Real mode: spawn directly for real-time progress ─────────────
    debug("spawn:", command, args.join(" "), "cwd:", options?.cwd ?? "(inherit)");
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

      // Parse stdout line-by-line (buffer incomplete trailing line)
      let stdoutBuffer = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) config.processLine(line);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        for (const line of text.split("\n")) config.processLine(line);
      });

      proc.on("close", (code) => {
        if (stdoutBuffer) config.processLine(stdoutBuffer);
        debug("process closed, code:", code, "killed:", killed);
        settle({ stdout, stderr, code: code ?? 1, killed });
      });

      proc.on("error", (err) => {
        debug("process error:", String(err));
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

// ── Build exec ─────────────────────────────────────────────────────────────

/**
 * Create an exec function that counts completed build tasks in real time.
 * Updates `state.completedTasks` as xcodebuild output streams in.
 */
export function createBuildExec(state: XcodeState, execFn?: ExecFn) {
  return createStreamingExec(
    {
      init() {
        state.completedTasks = 0;
      },
      processLine(line) {
        if (TASK_LINE_RE.test(line)) state.completedTasks++;
      },
    },
    execFn,
  );
}

// ── Test exec ──────────────────────────────────────────────────────────────

/**
 * Create an exec function that counts passed/failed tests in real time.
 * Updates `state.passedTests` and `state.failedTests` as output streams in.
 */
export function createTestExec(state: XcodeState, execFn?: ExecFn) {
  return createStreamingExec(
    {
      init() {
        state.passedTests = 0;
        state.failedTests = 0;
      },
      processLine(line) {
        if (TEST_PASSED_RE.test(line)) state.passedTests++;
        else if (TEST_FAILED_RE.test(line)) state.failedTests++;
      },
    },
    execFn,
  );
}
