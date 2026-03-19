import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExecFn } from "../types.js";
import { buildTestArgs, buildSimulatorDestination } from "../commands.js";
import { parseTestResult } from "../parsers.js";
import { discover, autoSelect, discoverSimulators, findSimulator } from "../discovery.js";
import { formatTestResult } from "../format.js";

export function registerTestTool(pi: ExtensionAPI, exec: ExecFn, cwd: string) {
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

    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Discovering project..." }] });

      let projectArg = params.workspace ?? params.project;
      let schemeArg = params.scheme;

      if (!projectArg || !schemeArg) {
        const discovery = await discover(exec, cwd);
        const selected = autoSelect(discovery, schemeArg);
        if (!projectArg && selected.project) projectArg = selected.project.path;
        if (!schemeArg && selected.scheme) schemeArg = selected.scheme.name;
      }

      if (!projectArg) {
        throw new Error("No Xcode project or workspace found. Specify one explicitly.");
      }

      // Resolve destination
      let destination = params.destination;
      if (!destination && params.simulator) {
        destination = buildSimulatorDestination(params.simulator);
      }
      if (!destination) {
        const simulators = await discoverSimulators(exec);
        const sim = findSimulator(simulators);
        if (sim) {
          destination = buildSimulatorDestination(sim.udid);
        }
      }

      const args = buildTestArgs({
        project: params.workspace ? undefined : projectArg,
        workspace: params.workspace ?? (projectArg.endsWith(".xcworkspace") ? projectArg : undefined),
        scheme: schemeArg,
        configuration: params.configuration ?? "Debug",
        destination,
        testPlan: params.testPlan,
        onlyTesting: params.onlyTesting,
        skipTesting: params.skipTesting,
      });

      onUpdate?.({ content: [{ type: "text", text: `Running tests: xcodebuild ${args.join(" ")}` }] });

      const result = await exec("xcodebuild", args, { signal, timeout: 1_200_000 });
      const combined = result.stdout + "\n" + result.stderr;
      const testResult = parseTestResult(combined);

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
