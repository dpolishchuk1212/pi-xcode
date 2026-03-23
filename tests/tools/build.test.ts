import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XcodeState } from "../../src/state.js";
import { createState } from "../../src/state.js";
import { registerBuildTool } from "../../src/tools/build.js";
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

/**
 * Creates a mock exec that captures state snapshots mid-flight when the build
 * command is invoked. The `callback` runs synchronously before the exec resolves.
 */
function createCapturingExec(
  responses: [pattern: string, result: Partial<ExecResult>][],
  callback: () => void,
): ExecFn {
  return vi.fn(async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) {
        if (key.includes("build")) callback();
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

describe("xcode_build tool", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("registers the tool", () => {
    const exec = createMockExec([]);
    registerBuildTool(mockPi as any, exec, "/project", createState());
    expect(mockPi.registerTool).toHaveBeenCalledOnce();
    expect(mockPi.getTool("xcode_build")).toBeDefined();
  });

  it("executes a successful build with explicit params", async () => {
    const exec = createMockExec([
      [
        "build",
        {
          stdout: "Compiling...\n** BUILD SUCCEEDED **\n",
          code: 0,
        },
      ],
    ]);

    registerBuildTool(mockPi as any, exec, "/project", createState());
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    const result = await tool.execute(
      "call-1",
      {
        project: "App.xcodeproj",
        scheme: "App",
        configuration: "Debug",
      },
      undefined,
      vi.fn(),
      ctx,
    );

    expect(result.content[0].text).toContain("BUILD SUCCEEDED");
    expect(result.details.success).toBe(true);
  });

  it("returns errors on build failure", async () => {
    const exec = createMockExec([
      [
        "build",
        {
          stdout: `/Users/dev/Foo.swift:10:5: error: cannot find 'x' in scope
** BUILD FAILED **`,
          code: 65,
        },
      ],
    ]);

    registerBuildTool(mockPi as any, exec, "/project", createState());
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    const result = await tool.execute(
      "call-1",
      {
        project: "App.xcodeproj",
        scheme: "App",
      },
      undefined,
      vi.fn(),
      ctx,
    );

    expect(result.content[0].text).toContain("BUILD FAILED");
    expect(result.details.success).toBe(false);
    expect(result.details.errors).toHaveLength(1);
    expect(result.details.errors[0].message).toContain("cannot find 'x'");
  });

  it("auto-discovers project and scheme when not specified", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/MyApp.xcodeproj\n" }],
      ["simctl", { stdout: JSON.stringify({ devices: {} }) }],
      ["-list", { stdout: "    Schemes:\n        MyApp\n" }],
      ["build", { stdout: "** BUILD SUCCEEDED **\n" }],
    ]);

    registerBuildTool(mockPi as any, exec, "/project", createState());
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn(), ctx);
    expect(result.details.success).toBe(true);
    // Verify xcodebuild was called with discovered project
    expect(exec).toHaveBeenCalledWith(
      "xcodebuild",
      expect.arrayContaining(["-project", "/project/MyApp.xcodeproj"]),
      expect.anything(),
    );
  });

  it("throws when no project found", async () => {
    const exec = createMockExec([
      ["find", { stdout: "", code: 0 }],
      ["simctl", { stdout: JSON.stringify({ devices: {} }) }],
    ]);

    registerBuildTool(mockPi as any, exec, "/empty", createState());
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    await expect(tool.execute("call-1", {}, undefined, vi.fn(), ctx)).rejects.toThrow(/No Xcode project/);
  });

  // ── appStatus lifecycle ────────────────────────────────────────────────

  it("sets appStatus to 'building' during the build", async () => {
    let statusDuringBuild: XcodeState["appStatus"] | undefined;
    let hadAbortController = false;

    const state = createState();
    const exec = createCapturingExec([["build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }]], () => {
      statusDuringBuild = state.appStatus;
      hadAbortController = !!state.activeAbortController;
    });

    registerBuildTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    await tool.execute("call-1", { project: "App.xcodeproj", scheme: "App" }, undefined, vi.fn(), ctx);

    expect(statusDuringBuild).toBe("building");
    expect(hadAbortController).toBe(true);
  });

  it("resets appStatus to 'idle' after a successful build", async () => {
    const state = createState();
    const exec = createMockExec([["build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }]]);

    registerBuildTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    await tool.execute("call-1", { project: "App.xcodeproj", scheme: "App" }, undefined, vi.fn(), ctx);

    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
    expect(state.activeOperationLabel).toBeUndefined();
  });

  it("resets appStatus to 'idle' after a failed build", async () => {
    const state = createState();
    const exec = createMockExec([
      [
        "build",
        {
          stdout: `/path/Foo.swift:1:1: error: bad\n** BUILD FAILED **`,
          code: 65,
        },
      ],
    ]);

    registerBuildTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    await tool.execute("call-1", { project: "App.xcodeproj", scheme: "App" }, undefined, vi.fn(), ctx);

    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
  });

  it("resets appStatus to 'idle' when exec throws", async () => {
    // createBuildExec swallows exec errors (returns ExecResult with code 1),
    // so the build tool won't throw — but state must still be cleaned up.
    const state = createState();
    const exec = vi.fn(async (command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (key.includes("build")) {
        throw new Error("xcodebuild crashed");
      }
      return { stdout: "", stderr: "", code: 1, killed: false };
    }) as ExecFn;

    registerBuildTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", { project: "App.xcodeproj", scheme: "App" }, undefined, vi.fn(), ctx);

    expect(result.details.success).toBe(false);
    expect(state.appStatus).toBe("idle");
    expect(state.activeAbortController).toBeUndefined();
    expect(state.activeOperationLabel).toBeUndefined();
  });

  it("calls updateStatusBar after the build completes", async () => {
    const state = createState();
    // Set a scheme so the status bar has content to render
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };
    const exec = createMockExec([["build", { stdout: "** BUILD SUCCEEDED **\n", code: 0 }]]);

    registerBuildTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_build");
    const ctx = createMockCtx();

    await tool.execute("call-1", { project: "App.xcodeproj", scheme: "App" }, undefined, vi.fn(), ctx);

    // updateStatusBar calls ui.setStatus — verify it rendered the scheme
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("xcode", expect.stringContaining("App"));
  });
});
