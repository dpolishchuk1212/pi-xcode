import { describe, expect, it, vi } from "vitest";
import { pickBestDestination } from "../src/auto-select.js";
import { autoDetect, formatDestinationLabel, getXcodebuildProjectArgs, refreshConfigurations } from "../src/resolve.js";
import { createState } from "../src/state.js";
import { updateStatusBar } from "../src/status-bar.js";
import type { Destination, ExecFn, ExecResult } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockExec(responses: Record<string, Partial<ExecResult>>): ExecFn {
  return vi.fn(async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        return { stdout: "", stderr: "", code: 0, killed: false, ...response };
      }
    }
    return { stdout: "", stderr: "", code: 1, killed: false };
  });
}

function createMockUI() {
  return {
    select: vi.fn(async () => undefined as string | undefined),
    setStatus: vi.fn(),
    notify: vi.fn(),
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  };
}

// ── getXcodebuildProjectArgs ───────────────────────────────────────────────

describe("getXcodebuildProjectArgs", () => {
  it("returns workspace flag for workspace type", () => {
    const args = getXcodebuildProjectArgs({ path: "/p/App.xcworkspace", type: "workspace" });
    expect(args.workspaceFlag).toBe("/p/App.xcworkspace");
    expect(args.projectFlag).toBeUndefined();
    expect(args.execCwd).toBeUndefined();
  });

  it("returns project flag for project type", () => {
    const args = getXcodebuildProjectArgs({ path: "/p/App.xcodeproj", type: "project" });
    expect(args.projectFlag).toBe("/p/App.xcodeproj");
    expect(args.workspaceFlag).toBeUndefined();
    expect(args.execCwd).toBeUndefined();
  });

  it("returns execCwd for package type", () => {
    const args = getXcodebuildProjectArgs({ path: "/p/sub/Package.swift", type: "package" });
    expect(args.projectFlag).toBeUndefined();
    expect(args.workspaceFlag).toBeUndefined();
    expect(args.execCwd).toBe("/p/sub");
  });
});

// ── updateStatusBar ────────────────────────────────────────────────────

describe("updateStatusBar", () => {
  it("clears status when nothing is set", () => {
    const ui = createMockUI();
    updateStatusBar("/project", createState(), ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", undefined);
  });

  it("shows project · scheme · configuration · destination", () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };
    state.activeConfiguration = "Debug";
    state.activeDestination = { platform: "iOS Simulator", id: "UUID", name: "iPhone 17", os: "18.0", arch: "arm64" };

    const ui = createMockUI();
    updateStatusBar("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "App.xcodeproj · App · Debug · iPhone 17 18.0");
  });

  it("shows project only when no scheme or destination", () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };

    const ui = createMockUI();
    updateStatusBar("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "App.xcodeproj");
  });

  it("shows package type", () => {
    const state = createState();
    state.activeProject = { path: "/project/Package.swift", type: "package" };
    state.activeScheme = { name: "MyLib", project: "/project/Package.swift" };

    const ui = createMockUI();
    updateStatusBar("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "Package.swift · MyLib");
  });

  it("shows workspace type", () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcworkspace", type: "workspace" };
    state.activeScheme = { name: "App", project: "/project/App.xcworkspace" };

    const ui = createMockUI();
    updateStatusBar("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "App.xcworkspace · App");
  });

  it("shows nested relative path", () => {
    const state = createState();
    state.activeProject = { path: "/project/sub/App.xcodeproj", type: "project" };

    const ui = createMockUI();
    updateStatusBar("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "sub/App.xcodeproj");
  });

  it("shows building status", () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };
    state.appStatus = "building";

    const ui = createMockUI();
    updateStatusBar("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", expect.stringContaining("Building"));
  });

  it("shows running status", () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };
    state.activeConfiguration = "Debug";
    state.activeDestination = { platform: "iOS Simulator", id: "UUID", name: "iPhone 16", os: "18.0", arch: "arm64" };
    state.appStatus = "running";

    const ui = createMockUI();
    updateStatusBar("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "App.xcodeproj · App · Debug · iPhone 16 18.0 · ▶ Running");
  });
});

// ── autoDetect ─────────────────────────────────────────────────────────────

describe("autoDetect", () => {
  it("auto-selects project, scheme, configuration, and destination silently", async () => {
    const exec = mockExec({
      find: { stdout: "/project/App.xcodeproj\n" },
      "-list": {
        stdout: `Information about project "App":
    Build Configurations:
        Debug
        Release

    Schemes:
        App
        AppTests
`,
      },
      "-showdestinations": {
        stdout: `Available destinations for the "App" scheme:
\t\t{ platform:iOS Simulator, arch:arm64, id:UUID-1, OS:18.0, name:iPhone 16 }
\t\t{ platform:iOS Simulator, arch:arm64, id:UUID-2, OS:18.0, name:iPad Air }
`,
      },
    });

    const state = createState();
    const ui = createMockUI();
    await autoDetect(exec, "/project", state, ui);

    // Project selected
    expect(state.activeProject?.path).toBe("/project/App.xcodeproj");
    expect(state.activeProject?.type).toBe("project");

    // Non-test scheme preferred
    expect(state.activeScheme?.name).toBe("App");

    // Configuration selected (prefers Debug)
    expect(state.activeConfiguration).toBe("Debug");
    expect(state.availableConfigurations).toEqual(["Debug", "Release"]);

    // Destination selected (prefers iPhone)
    expect(state.activeDestination?.name).toBe("iPhone 16");
    expect(state.availableDestinations).toHaveLength(2);

    // Unified status bar updated (mock theme returns unstyled text)
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "App.xcodeproj · App · Debug · iPhone 16 18.0");

    // No select prompts shown
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("does not crash when no projects found", async () => {
    const exec = mockExec({
      find: { stdout: "", code: 0 },
    });

    const state = createState();
    const ui = createMockUI();
    await autoDetect(exec, "/empty", state, ui);

    expect(state.activeProject).toBeUndefined();
    expect(state.activeDestination).toBeUndefined();
  });

  it("prefers workspace over project", async () => {
    const exec = mockExec({
      find: { stdout: "/p/App.xcworkspace\n/p/App.xcodeproj\n" },
      "-list": { stdout: "    Schemes:\n        App\n" },
      "-showdestinations": { stdout: "" },
    });

    const state = createState();
    await autoDetect(exec, "/p", state, createMockUI());

    expect(state.activeProject?.type).toBe("workspace");
  });
});

// ── pickBestDestination ────────────────────────────────────────────────────

describe("pickBestDestination", () => {
  const destinations: Destination[] = [
    { platform: "macOS", id: "MAC-1", name: "My Mac", arch: "arm64", variant: "Mac Catalyst" },
    { platform: "iOS", id: "placeholder", name: "Any iOS Device" },
    { platform: "iOS Simulator", id: "SIM-IPAD", name: "iPad Air", os: "18.0", arch: "arm64" },
    { platform: "iOS Simulator", id: "SIM-IP16", name: "iPhone 16", os: "18.0", arch: "arm64" },
    { platform: "iOS Simulator", id: "SIM-IP17", name: "iPhone 17", os: "18.1", arch: "arm64" },
  ];

  it("prefers iPhone simulator with latest OS", () => {
    const best = pickBestDestination(destinations);
    expect(best?.name).toBe("iPhone 17");
    expect(best?.os).toBe("18.1");
  });

  it("falls back to iPad if no iPhone sims", () => {
    const ipadsOnly = destinations.filter((d) => !d.name.startsWith("iPhone"));
    const best = pickBestDestination(ipadsOnly);
    expect(best?.name).toBe("iPad Air");
  });

  it("falls back to macOS if no simulators", () => {
    const noSims = destinations.filter((d) => !d.platform.includes("Simulator") && !d.id.includes("placeholder"));
    const best = pickBestDestination(noSims);
    expect(best?.name).toBe("My Mac");
  });

  it("returns undefined for empty list", () => {
    expect(pickBestDestination([])).toBeUndefined();
  });

  it("skips placeholders", () => {
    const onlyPlaceholder: Destination[] = [{ platform: "iOS", id: "dvtdevice-placeholder", name: "Any iOS Device" }];
    // Falls back to the placeholder since it's the only one
    const best = pickBestDestination(onlyPlaceholder);
    expect(best?.name).toBe("Any iOS Device");
  });
});

// ── refreshConfigurations ──────────────────────────────────────────────────

describe("refreshConfigurations", () => {
  it("discovers and auto-selects Debug", async () => {
    const exec = mockExec({
      "-list": {
        stdout: `    Build Configurations:
        Debug
        Release
        Staging
`,
      },
    });

    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    await refreshConfigurations(exec, state);

    expect(state.availableConfigurations).toEqual(["Debug", "Release", "Staging"]);
    expect(state.activeConfiguration).toBe("Debug");
  });

  it("falls back to first config when no Debug", async () => {
    const exec = mockExec({
      "-list": {
        stdout: `    Build Configurations:
        Release
        Staging
`,
      },
    });

    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    await refreshConfigurations(exec, state);

    expect(state.activeConfiguration).toBe("Release");
  });

  it("clears when no project", async () => {
    const exec = mockExec({});
    const state = createState();
    state.availableConfigurations = ["Debug"];
    state.activeConfiguration = "Debug";

    await refreshConfigurations(exec, state);

    expect(state.availableConfigurations).toEqual([]);
    expect(state.activeConfiguration).toBeUndefined();
  });
});

// ── formatDestinationLabel ─────────────────────────────────────────────────

describe("formatDestinationLabel", () => {
  it("formats simulator destination", () => {
    const label = formatDestinationLabel({
      platform: "iOS Simulator",
      id: "UUID",
      name: "iPhone 17",
      os: "18.0",
      arch: "arm64",
    });
    expect(label).toBe("iPhone 17 (18.0)");
  });

  it("formats macOS destination with variant", () => {
    const label = formatDestinationLabel({
      platform: "macOS",
      id: "UUID",
      name: "My Mac",
      arch: "arm64",
      variant: "Mac Catalyst",
    });
    expect(label).toBe("My Mac — Mac Catalyst");
  });

  it("formats simple destination", () => {
    const label = formatDestinationLabel({
      platform: "iOS",
      id: "UUID",
      name: "Any iOS Device",
    });
    expect(label).toBe("Any iOS Device");
  });
});
