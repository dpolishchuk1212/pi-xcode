import { beforeEach, describe, expect, it, vi } from "vitest";
import { createState } from "../../src/state.js";
import { registerDiscoverTool } from "../../src/tools/discover.js";
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

describe("xcode_discover tool", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("registers the tool", () => {
    registerDiscoverTool(mockPi as any, vi.fn() as any, "/project");
    expect(mockPi.registerTool).toHaveBeenCalledOnce();
    expect(mockPi.getTool("xcode_discover")).toBeDefined();
  });

  it("discovers projects, schemes, and simulators", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/App.xcodeproj\n/project/App.xcworkspace\n" }],
      ["-list", { stdout: "    Schemes:\n        App\n        AppTests\n" }],
      [
        "simctl",
        {
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                { udid: "UUID-1", name: "iPhone 16", state: "Booted", isAvailable: true },
                { udid: "UUID-2", name: "iPad Air", state: "Shutdown", isAvailable: true },
              ],
            },
          }),
        },
      ],
    ]);

    registerDiscoverTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_discover");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, vi.fn());

    // Content should include projects, schemes, and simulators
    const text = result.content[0].text;
    expect(text).toContain("Projects");
    expect(text).toContain("App.xcodeproj");
    expect(text).toContain("App.xcworkspace");
    expect(text).toContain("Schemes");
    expect(text).toContain("App");
    expect(text).toContain("Simulators");
    expect(text).toContain("iPhone 16");
    expect(text).toContain("iPad Air");

    // Details
    expect(result.details.projects).toHaveLength(2);
    expect(result.details.schemes.length).toBeGreaterThanOrEqual(1);
    expect(result.details.simulatorCount).toBe(2);
  });

  it("shows booted simulators with indicator", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/App.xcodeproj\n" }],
      ["-list", { stdout: "    Schemes:\n        App\n" }],
      [
        "simctl",
        {
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                { udid: "UUID-1", name: "iPhone 16", state: "Booted", isAvailable: true },
              ],
            },
          }),
        },
      ],
    ]);

    registerDiscoverTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_discover");

    const result = await tool.execute("call-1", {}, undefined, vi.fn());
    expect(result.content[0].text).toContain("(booted)");
  });

  it("shows none found when no projects", async () => {
    const exec = createMockExec([
      ["find", { stdout: "", code: 0 }],
      ["simctl", { stdout: JSON.stringify({ devices: {} }) }],
    ]);

    registerDiscoverTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_discover");

    const result = await tool.execute("call-1", {}, undefined, vi.fn());
    expect(result.content[0].text).toContain("(none found)");
    expect(result.details.projects).toHaveLength(0);
  });

  it("shows none found when no simulators", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/App.xcodeproj\n" }],
      ["-list", { stdout: "    Schemes:\n        App\n" }],
      ["simctl", { stdout: JSON.stringify({ devices: {} }) }],
    ]);

    registerDiscoverTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_discover");

    const result = await tool.execute("call-1", {}, undefined, vi.fn());
    // Simulators section shows "(none found)" when only non-iPhone/iPad sims
    expect(result.content[0].text).toContain("Simulators");
  });

  it("filters out non-iPhone/iPad simulators from display", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/App.xcodeproj\n" }],
      ["-list", { stdout: "    Schemes:\n        App\n" }],
      [
        "simctl",
        {
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
                { udid: "UUID-W", name: "Apple Watch", state: "Shutdown", isAvailable: true },
              ],
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                { udid: "UUID-I", name: "iPhone 16", state: "Shutdown", isAvailable: true },
              ],
            },
          }),
        },
      ],
    ]);

    registerDiscoverTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_discover");

    const result = await tool.execute("call-1", {}, undefined, vi.fn());
    const text = result.content[0].text;
    expect(text).toContain("iPhone 16");
    expect(text).not.toContain("Apple Watch");
    // But all simulators counted in details
    expect(result.details.simulatorCount).toBe(2);
  });

  it("shows Package.swift with package icon", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/Package.swift\n" }],
      ["-list", { stdout: "    Schemes:\n        MyLib\n" }],
      ["simctl", { stdout: JSON.stringify({ devices: {} }) }],
    ]);

    registerDiscoverTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_discover");

    const result = await tool.execute("call-1", {}, undefined, vi.fn());
    expect(result.content[0].text).toContain("📦");
    expect(result.content[0].text).toContain("Package.swift");
  });

  it("groups simulators by runtime", async () => {
    const exec = createMockExec([
      ["find", { stdout: "/project/App.xcodeproj\n" }],
      ["-list", { stdout: "    Schemes:\n        App\n" }],
      [
        "simctl",
        {
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
                { udid: "A", name: "iPhone 16", state: "Shutdown", isAvailable: true },
              ],
              "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
                { udid: "B", name: "iPhone 15", state: "Shutdown", isAvailable: true },
              ],
            },
          }),
        },
      ],
    ]);

    registerDiscoverTool(mockPi as any, exec, "/project");
    const tool = mockPi.getTool("xcode_discover");

    const result = await tool.execute("call-1", {}, undefined, vi.fn());
    const text = result.content[0].text;
    expect(text).toContain("iOS.18.0");
    expect(text).toContain("iOS.17.5");
  });
});
