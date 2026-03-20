import { describe, it, expect, vi } from "vitest";
import type { ExecFn, ExecResult } from "../src/types.js";
import { createState } from "../src/state.js";
import {
  resolveProjectAndScheme,
  getXcodebuildProjectArgs,
  updateProjectStatus,
  autoDetect,
} from "../src/resolve.js";

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
  };
}

// ── resolveProjectAndScheme ────────────────────────────────────────────────

describe("resolveProjectAndScheme", () => {
  it("uses explicit project param over state and auto-discover", async () => {
    const state = createState();
    state.activeProject = { path: "/old/Old.xcodeproj", type: "project" };
    state.activeScheme = { name: "Old", project: "/old/Old.xcodeproj" };

    const exec = mockExec({
      "-list": { stdout: "    Schemes:\n        NewApp\n" },
    });

    const ui = createMockUI();
    const resolved = await resolveProjectAndScheme(exec, "/project", state, ui, {
      project: "/new/New.xcodeproj",
    });

    expect(resolved.project.path).toBe("/new/New.xcodeproj");
    expect(resolved.project.type).toBe("project");
    expect(resolved.scheme).toBe("NewApp");
  });

  it("uses explicit workspace param", async () => {
    const exec = mockExec({
      "-list": { stdout: "    Schemes:\n        App\n" },
    });

    const resolved = await resolveProjectAndScheme(exec, "/project", createState(), createMockUI(), {
      workspace: "/ws/App.xcworkspace",
    });

    expect(resolved.project.type).toBe("workspace");
    expect(resolved.scheme).toBe("App");
  });

  it("uses active state when no explicit params", async () => {
    const state = createState();
    state.activeProject = { path: "/p/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/p/App.xcodeproj" };

    const exec = mockExec({});
    const resolved = await resolveProjectAndScheme(exec, "/project", state, createMockUI());

    expect(resolved.project.path).toBe("/p/App.xcodeproj");
    expect(resolved.scheme).toBe("App");
  });

  it("allows explicit scheme override with active state", async () => {
    const state = createState();
    state.activeProject = { path: "/p/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/p/App.xcodeproj" };

    const exec = mockExec({});
    const resolved = await resolveProjectAndScheme(exec, "/project", state, createMockUI(), {
      scheme: "AppTests",
    });

    expect(resolved.project.path).toBe("/p/App.xcodeproj");
    expect(resolved.scheme).toBe("AppTests");
  });

  it("auto-discovers and selects single project without UI", async () => {
    const exec = mockExec({
      find: { stdout: "/project/MyApp.xcodeproj\n" },
      "-list": { stdout: "    Schemes:\n        MyApp\n" },
    });

    const state = createState();
    const ui = createMockUI();
    const resolved = await resolveProjectAndScheme(exec, "/project", state, ui);

    expect(resolved.project.path).toBe("/project/MyApp.xcodeproj");
    expect(resolved.scheme).toBe("MyApp");
    expect(ui.select).not.toHaveBeenCalled();

    // Should save to state
    expect(state.activeProject?.path).toBe("/project/MyApp.xcodeproj");
    expect(state.activeScheme?.name).toBe("MyApp");
    expect(ui.setStatus).toHaveBeenCalled();
  });

  it("shows UI select when multiple projects found", async () => {
    const exec = mockExec({
      find: { stdout: "/project/A.xcodeproj\n/project/B.xcodeproj\n" },
      "-list": { stdout: "    Schemes:\n        SelectedScheme\n" },
    });

    const ui = createMockUI();
    ui.select.mockResolvedValueOnce("B.xcodeproj");

    const state = createState();
    const resolved = await resolveProjectAndScheme(exec, "/project", state, ui);

    expect(ui.select).toHaveBeenCalledWith("Select a project:", ["A.xcodeproj", "B.xcodeproj"]);
    expect(resolved.project.path).toBe("/project/B.xcodeproj");
  });

  it("throws when no projects found", async () => {
    const exec = mockExec({
      find: { stdout: "", code: 0 },
    });

    await expect(
      resolveProjectAndScheme(exec, "/empty", createState(), createMockUI()),
    ).rejects.toThrow(/No Xcode project/);
  });

  it("throws when user cancels project selection", async () => {
    const exec = mockExec({
      find: { stdout: "/p/A.xcodeproj\n/p/B.xcodeproj\n" },
    });

    const ui = createMockUI();
    ui.select.mockResolvedValueOnce(undefined); // User cancelled

    await expect(
      resolveProjectAndScheme(exec, "/p", createState(), ui),
    ).rejects.toThrow(/no project selected/i);
  });

  it("handles Package.swift discovery", async () => {
    const exec = mockExec({
      find: { stdout: "/project/Package.swift\n" },
      "-list": { stdout: "    Schemes:\n        MyLib\n" },
    });

    const state = createState();
    const resolved = await resolveProjectAndScheme(exec, "/project", state, createMockUI());

    expect(resolved.project.type).toBe("package");
    expect(resolved.project.path).toBe("/project/Package.swift");
    expect(resolved.scheme).toBe("MyLib");
  });
});

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

// ── updateProjectStatus ────────────────────────────────────────────────────

describe("updateProjectStatus", () => {
  it("clears status when no active project", () => {
    const ui = createMockUI();
    updateProjectStatus("/project", createState(), ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode-project", undefined);
  });

  it("shows relative path for project", () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcodeproj", type: "project" };
    state.activeScheme = { name: "App", project: "/project/App.xcodeproj" };

    const ui = createMockUI();
    updateProjectStatus("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode-project", "📁 App.xcodeproj");
  });

  it("shows 📦 for package type", () => {
    const state = createState();
    state.activeProject = { path: "/project/Package.swift", type: "package" };

    const ui = createMockUI();
    updateProjectStatus("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode-project", "📦 Package.swift");
  });

  it("shows 🗂️ for workspace type", () => {
    const state = createState();
    state.activeProject = { path: "/project/App.xcworkspace", type: "workspace" };

    const ui = createMockUI();
    updateProjectStatus("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode-project", "🗂️ App.xcworkspace");
  });

  it("shows nested relative path", () => {
    const state = createState();
    state.activeProject = { path: "/project/sub/App.xcodeproj", type: "project" };

    const ui = createMockUI();
    updateProjectStatus("/project", state, ui);
    expect(ui.setStatus).toHaveBeenCalledWith("xcode-project", "📁 sub/App.xcodeproj");
  });
});

// ── autoDetect ─────────────────────────────────────────────────────────────

describe("autoDetect", () => {
  it("auto-selects project, scheme, and simulator silently", async () => {
    const exec = mockExec({
      find: { stdout: "/project/App.xcodeproj\n" },
      "-list": { stdout: "    Schemes:\n        App\n        AppTests\n" },
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

    const state = createState();
    const ui = createMockUI();
    await autoDetect(exec, "/project", state, ui);

    // Project selected
    expect(state.activeProject?.path).toBe("/project/App.xcodeproj");
    expect(state.activeProject?.type).toBe("project");

    // Non-test scheme preferred
    expect(state.activeScheme?.name).toBe("App");

    // Simulator selected
    expect(state.activeSimulator?.name).toBe("iPhone 16");

    // Status bar updated for both
    expect(ui.setStatus).toHaveBeenCalledWith("xcode-project", "📁 App.xcodeproj");
    expect(ui.setStatus).toHaveBeenCalledWith("xcode", "📱 iPhone 16 (iOS.18.0)");

    // No select prompts shown
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("does not crash when no projects found", async () => {
    const exec = mockExec({
      find: { stdout: "", code: 0 },
      simctl: { stdout: JSON.stringify({ devices: {} }) },
    });

    const state = createState();
    const ui = createMockUI();
    await autoDetect(exec, "/empty", state, ui);

    expect(state.activeProject).toBeUndefined();
    expect(state.activeSimulator).toBeUndefined();
  });

  it("prefers workspace over project", async () => {
    const exec = mockExec({
      find: { stdout: "/p/App.xcworkspace\n/p/App.xcodeproj\n" },
      "-list": { stdout: "    Schemes:\n        App\n" },
      simctl: { stdout: JSON.stringify({ devices: {} }) },
    });

    const state = createState();
    await autoDetect(exec, "/p", state, createMockUI());

    expect(state.activeProject?.type).toBe("workspace");
  });
});
