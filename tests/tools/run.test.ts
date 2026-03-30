import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XcodeState } from "../../src/state.js";
import { createState } from "../../src/state.js";
import { registerRunTool } from "../../src/tools/run.js";
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
        // Trigger callback only for the actual build action (last arg is "build")
        if (args[args.length - 1] === "build") callback();
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
  state.activeScheme = { name: "App", project: "/project/App.xcodeproj", productType: "app" };
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

const BUILD_SETTINGS = `    PRODUCT_BUNDLE_IDENTIFIER = com.test.App
    BUILT_PRODUCTS_DIR = /DerivedData/Build/Products/Debug-iphonesimulator
    FULL_PRODUCT_NAME = App.app`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("xcode_run tool", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("registers the tool", () => {
    registerRunTool(mockPi as any, vi.fn() as any, "/project", createState());
    expect(mockPi.registerTool).toHaveBeenCalledOnce();
    expect(mockPi.getTool("xcode_run")).toBeDefined();
  });

  it("builds, installs, and launches on simulator", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["-showBuildSettings", { stdout: BUILD_SETTINGS }],
      [" build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }],
      ["simctl terminate", { code: 0 }],
      ["simctl boot", { code: 0 }],
      ["open -a Simulator", { code: 0 }],
      ["simctl install", { code: 0 }],
      ["simctl launch", { stdout: "com.test.App: 12345\n", code: 0 }],
      ["ps", { code: 0 }],
    ]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(true);
    expect(result.details.launched).toBe(true);
    expect(result.details.bundleId).toBe("com.test.App");
    expect(result.details.destinationType).toBe("simulator");
    expect(result.content[0].text).toContain("✅ App launched");
  });

  it("returns build failure without launching", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      [
        " build",
        {
          stdout: "/path/Foo.swift:1:1: error: bad\n** BUILD FAILED **",
          code: 65,
        },
      ],
    ]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(false);
    expect(result.details.launched).toBe(false);
    expect(result.content[0].text).toContain("Build failed");
  });

  it("throws when no destination available", async () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };
    // No destination set

    const exec = createMockExec([]);
    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    await expect(tool.execute("call-1", {}, undefined, vi.fn(), ctx)).rejects.toThrow(/No destination/);
  });

  it("throws when bundle ID cannot be resolved", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }],
      ["-showBuildSettings", { stdout: "    SOME_OTHER_SETTING = value\n" }],
      ["simctl terminate", { code: 0 }],
    ]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    await expect(tool.execute("call-1", {}, undefined, vi.fn(), ctx)).rejects.toThrow(/bundle ID/);
  });

  it("skips build when skipBuild is true", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["-showBuildSettings", { stdout: BUILD_SETTINGS }],
      ["simctl terminate", { code: 0 }],
      ["simctl boot", { code: 0 }],
      ["open -a Simulator", { code: 0 }],
      ["simctl install", { code: 0 }],
      ["simctl launch", { stdout: "com.test.App: 12345\n", code: 0 }],
      ["ps", { code: 0 }],
    ]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", { skipBuild: true }, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(true);
    expect(result.details.launched).toBe(true);
    // Verify no build command was issued
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls as [string, string[]][];
    const buildCalls = calls.filter(([cmd, args]) => args.includes("build"));
    expect(buildCalls).toHaveLength(0);
  });

  it("reports launch failure", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["-showBuildSettings", { stdout: BUILD_SETTINGS }],
      [" build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }],
      ["simctl terminate", { code: 0 }],
      ["simctl boot", { code: 0 }],
      ["open -a Simulator", { code: 0 }],
      ["simctl install", { code: 0 }],
      ["simctl launch", { stdout: "", stderr: "launch failed", code: 1 }],
    ]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(false);
    expect(result.details.launched).toBe(false);
    expect(result.content[0].text).toContain("❌ Failed to launch");
  });

  // ── appStatus lifecycle ──────────────────────────────────────────────────

  it("sets appStatus to building during build phase", async () => {
    let statusDuringBuild: XcodeState["appStatus"] | undefined;
    const state = stateWithSimulator();

    const exec = createCapturingExec(
      [
        ["-showBuildSettings", { stdout: BUILD_SETTINGS }],
        [" build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }],
        ["simctl terminate", { code: 0 }],
        ["simctl boot", { code: 0 }],
        ["open -a Simulator", { code: 0 }],
        ["simctl install", { code: 0 }],
        ["simctl launch", { stdout: "com.test.App: 12345\n", code: 0 }],
        ["ps", { code: 0 }],
      ],
      () => {
        statusDuringBuild = state.appStatus;
      },
    );

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(statusDuringBuild).toBe("building");
  });

  it("sets appStatus to running after successful launch", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["-showBuildSettings", { stdout: BUILD_SETTINGS }],
      [" build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }],
      ["simctl terminate", { code: 0 }],
      ["simctl boot", { code: 0 }],
      ["open -a Simulator", { code: 0 }],
      ["simctl install", { code: 0 }],
      ["simctl launch", { stdout: "com.test.App: 12345\n", code: 0 }],
      ["ps", { code: 0 }],
    ]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(state.appStatus).toBe("running");
  });

  it("resets appStatus to idle after build failure", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([[" build", { stdout: "** BUILD FAILED **\n", code: 65 }]]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
  });

  it("resets appStatus to idle after launch failure", async () => {
    const state = stateWithSimulator();
    const exec = createMockExec([
      ["-showBuildSettings", { stdout: BUILD_SETTINGS }],
      [" build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }],
      ["simctl terminate", { code: 0 }],
      ["simctl boot", { code: 0 }],
      ["open -a Simulator", { code: 0 }],
      ["simctl install", { code: 0 }],
      ["simctl launch", { code: 1, stderr: "failed" }],
    ]);

    registerRunTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(state.appStatus).toBe("idle");
  });

  it("throws when no active project or scheme", async () => {
    const exec = createMockExec([]);

    registerRunTool(mockPi as any, exec, "/project", createState());
    const tool = mockPi.getTool("xcode_run");
    const ctx = createMockCtx();

    await expect(tool.execute("call-1", {}, undefined, vi.fn(), ctx)).rejects.toThrow(/No active project or scheme/);
  });
});
