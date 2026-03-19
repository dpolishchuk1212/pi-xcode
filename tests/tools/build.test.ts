import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecFn, ExecResult } from "../../src/types.js";
import { registerBuildTool } from "../../src/tools/build.js";

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("xcode_build tool", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("registers the tool", () => {
    const exec = createMockExec([]);
    registerBuildTool(mockPi as any, exec, "/project");
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

    registerBuildTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_build");

    const result = await tool.execute("call-1", {
      project: "App.xcodeproj",
      scheme: "App",
      configuration: "Debug",
    }, undefined, vi.fn());

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

    registerBuildTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_build");

    const result = await tool.execute("call-1", {
      project: "App.xcodeproj",
      scheme: "App",
    }, undefined, vi.fn());

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

    registerBuildTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_build");

    const result = await tool.execute("call-1", {}, undefined, vi.fn());
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

    registerBuildTool(mockPi as any, exec, "/empty");
    const tool = mockPi.getTool("xcode_build");

    await expect(tool.execute("call-1", {}, undefined, vi.fn())).rejects.toThrow(
      /No Xcode project or workspace found/,
    );
  });
});
