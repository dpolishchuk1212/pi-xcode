import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XcodeState } from "../../src/state.js";
import { createState } from "../../src/state.js";
import { registerCleanTool } from "../../src/tools/clean.js";
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
        if (key.includes("clean") || key.includes("package")) callback();
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("xcode_clean tool", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("registers the tool", () => {
    registerCleanTool(mockPi as any, vi.fn() as any, "/project", createState());
    expect(mockPi.registerTool).toHaveBeenCalledOnce();
    expect(mockPi.getTool("xcode_clean")).toBeDefined();
  });

  it("cleans a project successfully", async () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };

    const exec = createMockExec([
      ["clean", { stdout: "** CLEAN SUCCEEDED **\n", code: 0 }],
    ]);

    registerCleanTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(true);
    expect(result.content[0].text).toContain("✅ Clean succeeded");
  });

  it("reports clean failure", async () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };

    const exec = createMockExec([
      ["clean", { stdout: "", stderr: "error: clean failed", code: 65 }],
    ]);

    registerCleanTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(false);
    expect(result.content[0].text).toContain("❌ Clean failed");
  });

  it("uses swift package clean for Package.swift", async () => {
    const state = createState();
    state.activeProject = { path: "/project/Package.swift", type: "package" };
    state.activeScheme = { name: "MyLib", project: "/project/Package.swift" };

    const exec = createMockExec([
      ["package clean", { code: 0 }],
    ]);

    registerCleanTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(true);
    expect(result.details.command).toBe("swift package clean");
    expect(exec).toHaveBeenCalledWith(
      "swift",
      ["package", "clean"],
      expect.objectContaining({ cwd: "/project" }),
    );
  });

  it("uses workspace flag for workspace projects", async () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcworkspace", type: "workspace" };
    state.activeScheme = { name: "App", project: "/project/App.xcworkspace" };

    const exec = createMockExec([
      ["clean", { code: 0 }],
    ]);

    registerCleanTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-workspace", "/project/App.xcworkspace"]),
      expect.anything(),
    );
  });

  it("uses explicit project param", async () => {
    const exec = createMockExec([
      ["-list", { stdout: "    Schemes:\n        Custom\n" }],
      ["clean", { code: 0 }],
    ]);

    registerCleanTool(mockPi as any, exec, "/project", createState());
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    await tool.execute("call-1", { project: "Custom.xcodeproj" }, undefined, vi.fn(), ctx);

    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-project", "Custom.xcodeproj"]),
      expect.anything(),
    );
  });

  it("auto-discovers project when not specified", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/MyApp.xcodeproj\n" }],
      ["simctl", { stdout: JSON.stringify({ devices: {} }) }],
      ["-list", { stdout: "    Schemes:\n        MyApp\n" }],
      ["-showdestinations", { stdout: "" }],
      ["clean", { code: 0 }],
    ]);

    registerCleanTool(mockPi as any, exec, "/project", createState());
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(result.details.success).toBe(true);
  });

  // ── appStatus lifecycle ──────────────────────────────────────────────────

  it("sets appStatus to cleaning during operation", async () => {
    let statusDuringClean: XcodeState["appStatus"] | undefined;
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };

    const exec = createCapturingExec(
      [["clean", { code: 0 }]],
      () => {
        statusDuringClean = state.appStatus;
      },
    );

    registerCleanTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(statusDuringClean).toBe("cleaning");
  });

  it("resets appStatus to idle after clean", async () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };

    const exec = createMockExec([["clean", { code: 0 }]]);

    registerCleanTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
  });

  it("resets appStatus to idle after failed clean", async () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };

    const exec = createMockExec([["clean", { stderr: "error", code: 1 }]]);

    registerCleanTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_clean");
    const ctx = createMockCtx();

    await tool.execute("call-1", {}, undefined, vi.fn(), ctx);

    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
  });
});
