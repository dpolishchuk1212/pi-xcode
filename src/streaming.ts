/**
 * Streaming xcodebuild execution with real-time task counting.
 * Uses Node's child_process.spawn to parse output line-by-line.
 */

import { spawn } from "node:child_process";
import type { ExecFn, ExecResult } from "./types.js";
import type { XcodeState } from "./state.js";

/**
 * Regex matching xcodebuild task lines. Each match = one completed build step.
 * These lines start at column 0 with a known verb.
 */
const TASK_LINE_RE = /^(CompileSwift|CompileC|SwiftCompile|Ld|Link|MergeSwiftModule|PhaseScriptExecution|CopySwiftLibs|ProcessInfoPlistFile|CompileAssetCatalog|CompileStoryboard|CodeSign|Validate|CpResource|CpHeader|Copy|ProcessProductPackaging|ProcessProductPackagingDER|GenerateAssetSymbols|WriteAuxiliaryFile|RegisterExecutionPolicyException|CreateUniversalBinary|SwiftDriver|SwiftEmitModule|SwiftMergeGeneratedHeaders|EmitSwiftModule)\b/;

/**
 * Count completed build tasks from xcodebuild output.
 */
export function countTasks(output: string): number {
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

    // If we have an injected exec (e.g. in tests), use it with post-hoc counting
    if (execFn) {
      return execFn(command, args, options).then((result) => {
        const combined = result.stdout + "\n" + result.stderr;
        state.completedTasks = countTasks(combined);
        return result;
      });
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

      // Handle abort signal
      if (options?.signal) {
        if (options.signal.aborted) {
          proc.kill("SIGTERM");
          killed = true;
          settle({ stdout, stderr, code: 1, killed: true });
          return;
        }
        options.signal.addEventListener("abort", () => {
          killed = true;
          proc.kill("SIGTERM");
        }, { once: true });
      }

      // Handle timeout
      if (options?.timeout) {
        setTimeout(() => {
          if (!settled) {
            killed = true;
            proc.kill("SIGTERM");
          }
        }, options.timeout);
      }
    });
  };
}
