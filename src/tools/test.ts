import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { buildDestinationString, buildSimulatorDestination, buildTestArgs } from "../commands.js";
import { formatTestResult } from "../format.js";
import { parseTestResult } from "../parsers.js";
import { getXcodebuildProjectArgs, resolveProjectAndScheme } from "../resolve.js";
import type { XcodeState } from "../state.js";
import { clearOperation, startOperation } from "../state.js";
import { startSpinner, stopSpinner, updateStatusBar } from "../status-bar.js";
import { createTestExec } from "../streaming.js";
import type { ExecFn, TestResult } from "../types.js";

export function registerTestTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_test",
    label: "Xcode Test",
    description:
      "Run unit tests or UI tests for an Xcode project. Returns a structured summary of passed/failed tests.",
    promptSnippet: "Run Xcode unit or UI tests and return structured pass/fail results",
    promptGuidelines: [
      "Use active project, scheme, configuration, and destination if user doesn't specify others explicitly",
      "Use onlyTesting to run a specific test class or method, e.g. 'MyAppTests/MyTests/testFoo'.",
    ],
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Path to .xcodeproj" })),
      workspace: Type.Optional(Type.String({ description: "Path to .xcworkspace" })),
      scheme: Type.Optional(Type.String({ description: "Build scheme (auto-discovered if omitted)" })),
      configuration: Type.Optional(Type.String({ description: "Debug or Release (default: Debug)" })),
      destination: Type.Optional(Type.String({ description: "Build destination" })),
      simulator: Type.Optional(Type.String({ description: "Simulator name or UDID" })),
      testPlan: Type.Optional(Type.String({ description: "Test plan to use" })),
      onlyTesting: Type.Optional(
        Type.Array(Type.String(), { description: "Run only these tests (e.g. 'MyTests/testFoo')" }),
      ),
      skipTesting: Type.Optional(Type.Array(Type.String(), { description: "Skip these tests" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Discovering project..." }], details: undefined });

      // ── Resolve project and scheme ───────────────────────────────────
      console.log("[xcode_test] params:", JSON.stringify(params));
      const resolved = await resolveProjectAndScheme(exec, cwd, state, ctx.ui, {
        project: params.project,
        workspace: params.workspace,
        scheme: params.scheme,
      });
      console.log("[xcode_test] resolved project:", resolved.project.path, "scheme:", resolved.scheme);

      const xcodeArgs = getXcodebuildProjectArgs(resolved.project);
      console.log("[xcode_test] xcodeArgs:", JSON.stringify(xcodeArgs));

      // ── Resolve destination ──────────────────────────────────────────
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
        scheme: resolved.scheme,
        configuration,
        destination,
        testPlan: params.testPlan,
        onlyTesting: params.onlyTesting,
        skipTesting: params.skipTesting,
      });

      console.log("[xcode_test] full command: xcodebuild", args.join(" "));
      console.log("[xcode_test] destination:", destination);
      console.log("[xcode_test] configuration:", configuration);

      onUpdate?.({
        content: [{ type: "text", text: `Running tests: xcodebuild ${args.join(" ")}` }],
        details: undefined,
      });

      state.appStatus = "testing";
      startSpinner(cwd, state, ctx.ui);

      const combinedSignal = startOperation(state, `Test ${resolved.scheme ?? "project"}`, signal);

      let testResult: TestResult | undefined;
      try {
        const testExecFn = createTestExec(state, exec);
        const result = await testExecFn("xcodebuild", args, {
          signal: combinedSignal,
          timeout: 1_200_000,
          cwd: xcodeArgs.execCwd,
        });
        console.log("[xcode_test] exit code:", result.code, "killed:", result.killed);
        console.log("[xcode_test] stdout length:", result.stdout.length, "stderr length:", result.stderr.length);

        const combined = `${result.stdout}\n${result.stderr}`;

        // Log last 3000 chars of output to see what xcodebuild actually printed
        console.log("[xcode_test] --- RAW OUTPUT (last 3000 chars) ---");
        console.log(combined.slice(-3000));
        console.log("[xcode_test] --- END RAW OUTPUT ---");

        testResult = parseTestResult(combined);
        console.log("[xcode_test] parsed result: total=%d passed=%d failed=%d duration=%s",
          testResult.total, testResult.passed, testResult.failed, testResult.duration.toFixed(3));
        console.log("[xcode_test] test cases found:", testResult.cases.length);
        if (testResult.cases.length > 0) {
          for (const tc of testResult.cases) {
            console.log("[xcode_test]   %s %s.%s (%.3fs)", tc.passed ? "✓" : "✗", tc.suite, tc.name, tc.duration);
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
