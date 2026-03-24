import { describe, expect, it, vi } from "vitest";
import {
  discoverConfigurations,
  discoverProjects,
  discoverSchemes,
  discoverSimulators,
  findSimulator,
} from "../src/discovery.js";
import type { ExecFn, ExecResult, Simulator } from "../src/types.js";

// ── Helper: create a mock exec ─────────────────────────────────────────────

function mockExec(responses: Record<string, Partial<ExecResult>>): ExecFn {
  return vi.fn(async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;

    // Find a matching response by prefix
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout: "", stderr: "", code: 0, killed: false, ...response };
      }
    }

    return { stdout: "", stderr: "", code: 1, killed: false };
  });
}

// ── discoverProjects ───────────────────────────────────────────────────────

describe("discoverProjects", () => {
  it("finds .xcodeproj and .xcworkspace files", async () => {
    const exec = mockExec({
      find: {
        stdout: "/project/MyApp.xcworkspace\n/project/MyApp.xcodeproj\n",
      },
    });

    const projects = await discoverProjects(exec, "/project");
    expect(projects).toHaveLength(2);
    // Workspaces should sort first
    expect(projects[0].type).toBe("workspace");
    expect(projects[1].type).toBe("project");
  });

  it("filters out Pods and swiftpm workspaces", async () => {
    const exec = mockExec({
      find: {
        stdout: `/project/MyApp.xcodeproj
/project/Pods/Pods.xcodeproj
/project/.swiftpm/xcode/package.xcworkspace
`,
      },
    });

    const projects = await discoverProjects(exec, "/project");
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/project/MyApp.xcodeproj");
  });

  it("finds Package.swift files", async () => {
    const exec = mockExec({
      find: {
        stdout: "/project/Package.swift\n",
      },
    });

    const projects = await discoverProjects(exec, "/project");
    expect(projects).toHaveLength(1);
    expect(projects[0].type).toBe("package");
    expect(projects[0].path).toBe("/project/Package.swift");
  });

  it("sorts: workspace > project > package", async () => {
    const exec = mockExec({
      find: {
        stdout: "/project/Package.swift\n/project/App.xcodeproj\n/project/App.xcworkspace\n",
      },
    });

    const projects = await discoverProjects(exec, "/project");
    expect(projects).toHaveLength(3);
    expect(projects[0].type).toBe("workspace");
    expect(projects[1].type).toBe("project");
    expect(projects[2].type).toBe("package");
  });

  it("filters out .build directory Package.swift", async () => {
    const exec = mockExec({
      find: {
        stdout: `/project/Package.swift
/project/.build/checkouts/Dep/Package.swift
`,
      },
    });

    const projects = await discoverProjects(exec, "/project");
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe("/project/Package.swift");
  });

  it("returns empty when find fails", async () => {
    const exec = mockExec({ find: { code: 1 } });
    const projects = await discoverProjects(exec, "/project");
    expect(projects).toEqual([]);
  });
});

// ── discoverSchemes ────────────────────────────────────────────────────────

describe("discoverSchemes", () => {
  it("parses schemes from xcodebuild -list", async () => {
    const exec = mockExec({
      "-list": {
        stdout: `Information about project "MyApp":
    Targets:
        MyApp

    Schemes:
        MyApp
        MyAppTests
`,
      },
    });

    const schemes = await discoverSchemes(exec, "/project/MyApp.xcodeproj");
    expect(schemes).toHaveLength(2);
    expect(schemes[0].name).toBe("MyApp");
    expect(schemes[1].name).toBe("MyAppTests");
  });
});

// ── discoverConfigurations ──────────────────────────────────────────────────

describe("discoverConfigurations", () => {
  it("parses configurations from xcodebuild -list", async () => {
    const exec = mockExec({
      "-list": {
        stdout: `Information about project "MyApp":
    Build Configurations:
        Debug
        Release

    Schemes:
        MyApp
`,
      },
    });

    const configs = await discoverConfigurations(exec, "/project/MyApp.xcodeproj");
    expect(configs).toEqual(["Debug", "Release"]);
  });

  it("uses cwd for Package.swift", async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[], options?: { cwd?: string }) => {
      expect(options?.cwd).toBe("/project");
      return {
        stdout: "    Build Configurations:\n        Debug\n        Release\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    }) as ExecFn;

    await discoverConfigurations(exec, "/project/Package.swift");
  });
});

// ── discoverSimulators ─────────────────────────────────────────────────────

describe("discoverSimulators", () => {
  it("parses simulator list", async () => {
    const exec = mockExec({
      simctl: {
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
              { udid: "UUID-1", name: "iPhone 16", state: "Shutdown", isAvailable: true },
            ],
          },
        }),
      },
    });

    const sims = await discoverSimulators(exec);
    expect(sims).toHaveLength(1);
    expect(sims[0].name).toBe("iPhone 16");
  });

  it("returns empty on failure", async () => {
    const exec = mockExec({ simctl: { code: 1 } });
    const sims = await discoverSimulators(exec);
    expect(sims).toEqual([]);
  });
});

// ── discover (full) ────────────────────────────────────────────────────────

// ── findSimulator ──────────────────────────────────────────────────────────

describe("findSimulator", () => {
  const simulators: Simulator[] = [
    { udid: "UUID-1", name: "iPhone 15", runtime: "iOS.17.5", state: "Shutdown", isAvailable: true },
    { udid: "UUID-2", name: "iPhone 16", runtime: "iOS.18.0", state: "Shutdown", isAvailable: true },
    { udid: "UUID-3", name: "iPhone 16", runtime: "iOS.18.0", state: "Booted", isAvailable: true },
    { udid: "UUID-4", name: "iPad Pro", runtime: "iOS.18.0", state: "Shutdown", isAvailable: true },
  ];

  it("finds by UDID", () => {
    const sim = findSimulator(simulators, "UUID-1");
    expect(sim?.name).toBe("iPhone 15");
  });

  it("finds by name, preferring booted", () => {
    const sim = findSimulator(simulators, "iPhone 16");
    expect(sim?.udid).toBe("UUID-3"); // booted one
  });

  it("defaults to latest booted iPhone", () => {
    const sim = findSimulator(simulators);
    expect(sim?.udid).toBe("UUID-3");
  });

  it("defaults to latest iPhone if none booted", () => {
    const notBooted: Simulator[] = [
      { udid: "UUID-1", name: "iPhone 15", runtime: "iOS.17.5", state: "Shutdown", isAvailable: true },
      { udid: "UUID-2", name: "iPhone 16", runtime: "iOS.18.0", state: "Shutdown", isAvailable: true },
    ];
    const sim = findSimulator(notBooted);
    expect(sim?.udid).toBe("UUID-2"); // latest runtime
  });

  it("returns undefined for empty list", () => {
    expect(findSimulator([])).toBeUndefined();
  });
});
