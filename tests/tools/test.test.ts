import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XcodeState } from "../../src/state.js";
import { createState } from "../../src/state.js";
import { registerTestTool } from "../../src/tools/test.js";
import type { ExecFn, ExecResult } from "../../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockPi() {
  const tools: Record<string, any> = {};
  return {
    registerTool: vi.fn((def: any) => {
      tools[def.name] = def;
    }),
    getTool: (name: string) => tools[name],
  };
}

function createMockExec(responses: [pattern: string, result: Partial<ExecResult>][]): ExecFn {
  return vi.fn(async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) {
        return { stdout: "", stderr: "", code: 0, killed: false, ...response };
      }
    }
    return { stdout: "", stderr: "", code: 1, killed: false };
  });
}

function createCapturingExec(
  responses: [pattern: string, result: Partial<ExecResult>][],
  callback: () => void,
): ExecFn {
  return vi.fn(async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) {
        if (key.includes("test")) callback();
        return { stdout: "", stderr: "", code: 0, killed: false, ...response };
      }
    }
    return { stdout: "", stderr: "", code: 1, killed: false };
  });
}

function createMockCtx() {
  return {
    ui: {
      select: vi.fn(async () => undefined),
      setStatus: vi.fn(),
      notify: vi.fn(),
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    },
  };
}

function stateWithSimulator(): XcodeState {
  const state = createState();
  state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
  state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };
  state.activeConfiguration = "Debug";
  state.activeDestination = {
    platform: "iOS Simulator",
    id: "SIM-UUID",
    name: "iPhone 16",
    os: "18.0",
    arch: "arm64",
  };
  return state;
}

const ALL_PASSING_OUTPUT = `Test Case '-[AppTests testA]' passed (0.001 seconds).
Test Case '-[AppTests testB]' passed (0.002 seconds).
Executed 2 tests, with 0 failures (0 unexpected) in 0.003 (0.010) seconds`;

const MIXED_OUTPUT = `Test Case '-[AppTests testOk]' passed (0.001 seconds).
/Users/dev/Tests.swift:42: error: -[AppTests testBad] : XCTAssertEqual failed: ("1") is not equal to ("2")
Test Case '-[AppTests testBad]' failed (0.005 seconds).
Executed 2 tests, with 1 failure (0 unexpected) in 0.006 (0.020) seconds`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("xcode_test tool", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("registers the tool", () => {
    registerTestTool(mockPi as any, vi.fn() as any, "/project", createState());
    expect(mockPi.registerTool).toHaveBeenCalledOnce();
    expect(mockPi.getTool("xcode_test")).toBeDefined();
  });

  it("runs tests and returns all-passing result", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(true);
    expect(result.details.passed).toBe(2);
    expect(result.details.failed).toBe(0);
    expect(result.details.total).toBe(2);
    expect(result.content[0].text).toContain("ALL TESTS PASSED");
  });

  it("runs tests and returns failures", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: MIXED_OUTPUT, code: 65 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(false);
    expect(result.details.passed).toBe(1);
    expect(result.details.failed).toBe(1);
    expect(result.details.total).toBe(2);
    expect(result.details.failedTests).toHaveLength(1);
    expect(result.details.failedTests[0].name).toBe("testBad");
    expect(result.content[0].text).toContain("TESTS FAILED");
  });

  it("passes onlyTesting filter to xcodebuild", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute(
      "call-1",
      { onlyTesting: ["AppTests/testA"] },
      undefined,
      vi.fn(),
      ctx,
    );

    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-only-testing", "AppTests/testA"]),
      expect.anything(),
    );
  });

  it("passes skipTesting filter to xcodebuild", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute(
      "call-1",
      { skipTesting: ["SlowTests"] },
      undefined,
      vi.fn(),
      ctx,
    );

    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-skip-testing", "SlowTests"]),
      expect.anything(),
    );
  });

  it("passes testPlan to xcodebuild", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute(
      "call-1",
      { testPlan: "SmokePlan" },
      undefined,
      vi.fn(),
      ctx,
    );

    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-testPlan", "SmokePlan"]),
      expect.anything(),
    );
  });

  it("always uses active project and scheme from state", async () => {
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    const state = stateWithSimulator();
    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-project", "/project/App.xcodeproj", "-scheme", "App"]),
      expect.anything(),
    );
  });

  it("uses simulator param as destination", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute(
      "call-1",
      { simulator: "iPhone 17" },
      undefined,
      vi.fn(),
      ctx,
    );

    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-destination", "platform=iOS Simulator,name=iPhone 17"]),
      expect.anything(),
    );
  });

  it("throws when no active project or scheme", async () => {
    const exec = createMockExec([]);

    registerTestTool(mockPi as any, exec, "/project", createState());
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await expect(tool.execute("call-1", {}, undefined, vi.fn(), ctx)).rejects.toThrow(
      /No active project or scheme/,
    );
  });

  // ── appStatus lifecycle ──────────────────────────────────────────────────

  it("sets appStatus to testing during test execution", async () => {
    let statusDuringTest: XcodeState["appStatus"] | undefined;
    const state = stateWithSimulator();

    const exec = createCapturingExec(
      [["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }]],
      () => {
        statusDuringTest = state.appStatus;
      },
    );

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(statusDuringTest).toBe("testing");
  });

  it("resets appStatus to idle after tests complete", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
    expect(state.activeOperationLabel).toBeUndefined();
  });

  it("resets appStatus to idle after test failures", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: MIXED_OUTPUT, code: 65 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
  });

  it("includes command in result details", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["test", { stdout: ALL_PASSING_OUTPUT, code: 0 }],
    ]);

    registerTestTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_test");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(result.details.command).toContain("xcodebuild");
    expect(result.details.command).toContain("test");
  });
});
