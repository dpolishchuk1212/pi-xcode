import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import type { XcodeState } from "../state.js";
import { startOperation, clearOperation } from "../state.js";
import { createTestExec } from "../streaming.js";
import { buildTestArgs, buildDestinationString, buildSimulatorDestination } from "../commands.js";
import { parseTestResult } from "../parsers.js";
import { resolveProjectAndScheme, getXcodebuildProjectArgs, updateStatusBar, startSpinner, stopSpinner } from "../resolve.js";
import { formatTestResult } from "../format.js";

export function registerTestTool(pi: ExtensionAPI, exec: ExecFn, cwd: string, state: XcodeState) {
  pi.registerTool({
    name: "xcode_test",
    label: "Xcode Test",
    description:
      "Run unit tests or UI tests for an Xcode project. Returns a structured summary of passed/failed tests.",
    promptSnippet: "Run Xcode unit or UI tests and return structured pass/fail results",
    promptGuidelines: [
      "Use xcode_test to run tests. It returns a summary with pass/fail counts and individual test case results.",
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
      const resolved = await resolveProjectAndScheme(exec, cwd, state, ctx.ui, {
        project: params.project,
        workspace: params.workspace,
        scheme: params.scheme,
      });

      const xcodeArgs = getXcodebuildProjectArgs(resolved.project);

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

      onUpdate?.({ content: [{ type: "text", text: `Running tests: xcodebuild ${args.join(" ")}` }], details: undefined });

      state.appStatus = "testing";
      startSpinner(cwd, state, ctx.ui);

      const combinedSignal = startOperation(state, `Test ${resolved.scheme ?? "project"}`, signal);

      let testResult;
      try {
        const testExecFn = createTestExec(state, exec);
        const result = await testExecFn("xcodebuild", args, { signal: combinedSignal, timeout: 1_200_000, cwd: xcodeArgs.execCwd });
        const combined = result.stdout + "\n" + result.stderr;
        testResult = parseTestResult(combined);
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
