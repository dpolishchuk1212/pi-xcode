import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildDestinationString, buildSimulatorDestination, buildTestArgs } from "../commands.js";
import { formatTestResult } from "../format.js";
import { createLogger } from "../log.js";
import { parseTestResult } from "../parsers.js";
import { formatDestinationLabel, getXcodebuildProjectArgs } from "../resolve.js";
import type { XcodeState } from "../state.js";
import { clearOperation, startOperation } from "../state.js";
import { startSpinner, stopSpinner, updateStatusBar } from "../status-bar.js";
import { createTestExec } from "../streaming.js";
import type { ExecFn, TestResult } from "../types.js";

const debug = createLogger("test");

export function registerTestTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_test",
    label: "Xcode Test",
    description:
      "Run unit tests or UI tests for the active Xcode project. Uses the active project, scheme, configuration, and destination. Returns a structured summary of passed/failed tests.",
    promptSnippet: "Run Xcode unit or UI tests and return structured pass/fail results",
    promptGuidelines: [
      "Always uses the active project, scheme, configuration, and destination — do NOT pass project, workspace, or scheme",
      "NEVER pass simulator or destination unless the user EXPLICITLY asks to use a different simulator/device — the active destination is already the correct default",
      "Use onlyTesting to run a specific test class or method, e.g. 'MyAppTests/MyTests/testFoo'.",
    ],
    parameters: Type.Object({
      configuration: Type.Optional(Type.String({ description: "Debug or Release (default: active configuration)" })),
      destination: Type.Optional(Type.String({ description: "Build destination. Only pass if user explicitly requests a different destination." })),
      simulator: Type.Optional(Type.String({ description: "Simulator name or UDID. Only pass if user explicitly requests a different simulator." })),
      testPlan: Type.Optional(Type.String({ description: "Test plan to use" })),
      onlyTesting: Type.Optional(
        Type.Array(Type.String(), { description: "Run only these tests (e.g. 'MyTests/testFoo')" }),
      ),
      skipTesting: Type.Optional(Type.Array(Type.String(), { description: "Skip these tests" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // ── Validate active state ────────────────────────────────────────
      if (!state.activeProject || !state.activeScheme) {
        throw new Error("No active project or scheme. Use /project and /scheme to select one.");
      }

      debug("params:", JSON.stringify(params));
      debug("active project:", state.activeProject.path, "scheme:", state.activeScheme.name);

      const xcodeArgs = getXcodebuildProjectArgs(state.activeProject);
      debug("xcodeArgs:", JSON.stringify(xcodeArgs));

      // ── Resolve destination ──────────────────────────────────────────
      // Priority: explicit destination > explicit simulator > active destination
      let destination = params.destination;
      if (!destination && params.simulator) {
        destination = buildSimulatorDestination(params.simulator);
      }
      if (!destination && state.activeDestination) {
        destination = buildDestinationString(state.activeDestination);
      }

      const configuration = params.configuration ?? state.activeConfiguration ?? "Debug";

      const args = buildTestArgs({
        project: xcodeArgs.projectFlag,
        workspace: xcodeArgs.workspaceFlag,
        scheme: state.activeScheme.name,
        configuration,
        destination,
        testPlan: params.testPlan,
        onlyTesting: params.onlyTesting,
        skipTesting: params.skipTesting,
      });

      debug("full command: xcodebuild", args.join(" "));
      debug("destination:", destination);
      debug("configuration:", configuration);

      const destLabel = state.activeDestination
        ? ` on ${formatDestinationLabel(state.activeDestination)}`
        : "";
      onUpdate?.({
        content: [{ type: "text", text: `Testing ${state.activeScheme.name} (${configuration})${destLabel}...` }],
        details: undefined,
      });

      state.appStatus = "testing";
      startSpinner(cwd, state, ctx.ui);

      const combinedSignal = startOperation(state, `Test ${state.activeScheme.name} (${configuration})${destLabel}`, signal);

      let testResult: TestResult | undefined;
      try {
        const testExecFn = createTestExec(state, exec);
        const result = await testExecFn("xcodebuild", args, {
          signal: combinedSignal,
          timeout: 1_200_000,
          cwd: xcodeArgs.execCwd,
        });
        debug("exit code:", result.code, "killed:", result.killed);
        debug("stdout length:", result.stdout.length, "stderr length:", result.stderr.length);

        const combined = `${result.stdout}\n${result.stderr}`;

        // Log last 3000 chars of output to see what xcodebuild actually printed
        debug("--- RAW OUTPUT (last 3000 chars) ---");
        debug(combined.slice(-3000));
        debug("--- END RAW OUTPUT ---");

        testResult = parseTestResult(combined);
        debug("parsed result: total=%d passed=%d failed=%d duration=%s",
          testResult.total, testResult.passed, testResult.failed, testResult.duration.toFixed(3));
        debug("test cases found:", testResult.cases.length);
        if (testResult.cases.length > 0) {
          for (const tc of testResult.cases) {
            debug("  %s %s.%s (%.3fs)", tc.passed ? "✓" : "✗", tc.suite, tc.name, tc.duration);
          }
        }
      } finally {
        clearOperation(state);
        stopSpinner(state);
        state.appStatus = "idle";
        updateStatusBar(cwd, state, ctx.ui);
      }

      return {
        content: [{ type: "text", text: formatTestResult(testResult) }],
        details: {
          success: testResult.success,
          passed: testResult.passed,
          failed: testResult.failed,
          total: testResult.total,
          duration: testResult.duration,
          failedTests: testResult.cases.filter((c) => !c.passed),
          command: `xcodebuild ${args.join(" ")}`,
        },
      };
    },
  });
}
