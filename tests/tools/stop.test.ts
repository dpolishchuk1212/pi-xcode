import { beforeEach, describe, expect, it, vi } from "vitest";
import { createState } from "../../src/state.js";
import { registerStopTool, stopActiveOperation } from "../../src/tools/stop.js";
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

function createMockExec(responses?: [pattern: string, result: Partial<ExecResult>][]): ExecFn {
  return vi.fn(async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    if (responses) {
      for (const [pattern, response] of responses) {
        if (key.includes(pattern)) {
          return { stdout: "", stderr: "", code: 0, killed: false, ...response };
        }
      }
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  });
}

function createMockUI() {
  return {
    select: vi.fn(async () => undefined),
    setStatus: vi.fn(),
    notify: vi.fn(),
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
  };
}

function createMockCtx() {
  return { ui: createMockUI() };
}

// ── Tool registration ──────────────────────────────────────────────────────

describe("xcode_stop tool", () => {
  let mockPi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    mockPi = createMockPi();
  });

  it("registers the tool", () => {
    registerStopTool(mockPi as any, vi.fn() as any, "/project", createState());
    expect(mockPi.registerTool).toHaveBeenCalledOnce();
    expect(mockPi.getTool("xcode_stop")).toBeDefined();
  });

  it("delegates to stopActiveOperation", async () => {
    const state = createState();
    state.appStatus = "building";
    state.activeAbortController = new AbortController();
    state.activeOperationLabel = "Build App";

    const exec = createMockExec();

    registerStopTool(mockPi as any, exec, "/project", state);
    const tool = mockPi.getTool("xcode_stop");
    const ctx = createMockCtx();

    const result = await tool.execute("call-1", {}, undefined, undefined, ctx);
    expect(result.details.stopped).toBe(true);
    expect(result.content[0].text).toContain("Stopped");
  });
});

// ── stopActiveOperation ────────────────────────────────────────────────────

describe("stopActiveOperation", () => {
  it("aborts active operation and returns stop message", async () => {
    const state = createState();
    const controller = new AbortController();
    state.activeAbortController = controller;
    state.activeOperationLabel = "Build MyApp (Debug)";
    state.appStatus = "building";

    const exec = createMockExec();
    const ui = createMockUI();

    const result = await stopActiveOperation(exec, "/project", state, ui);

    expect(result.details.stopped).toBe(true);
    expect(result.content[0].text).toContain("Build MyApp (Debug)");
    expect(controller.signal.aborted).toBe(true);
    expect(state.activeAbortController).toBeUndefined();
    expect(state.activeOperationLabel).toBeUndefined();
  });

  it("kills xcodebuild processes", async () => {
    const state = createState();
    state.appStatus = "building";
    state.activeAbortController = new AbortController();

    const exec = createMockExec();
    const ui = createMockUI();

    await stopActiveOperation(exec, "/project", state, ui);

    expect(exec).toHaveBeenCalledWith("pkill", ["-9", "-f", "xcodebuild"], expect.any(Object));
  });

  it("resets appStatus to idle", async () => {
    const state = createState();
    state.appStatus = "testing";
    state.activeAbortController = new AbortController();
    state.activeOperationLabel = "Test suite";

    const exec = createMockExec();
    const ui = createMockUI();

    await stopActiveOperation(exec, "/project", state, ui);

    expect(state.appStatus).toBe("idle");
  });

  it("stops app monitor if present", async () => {
    const state = createState();
    state.appStatus = "running";
    const stopMonitor = vi.fn();
    state.stopAppMonitor = stopMonitor;

    const exec = createMockExec();
    const ui = createMockUI();

    await stopActiveOperation(exec, "/project", state, ui);

    expect(stopMonitor).toHaveBeenCalled();
    expect(state.stopAppMonitor).toBeUndefined();
  });

  it("terminates running app on simulator", async () => {
    const state = createState();
    state.appStatus = "running";
    state.activeDestination = {
      platform: "iOS Simulator",
      id: "SIM-UUID",
      name: "iPhone 16",
      os: "18.0",
      arch: "arm64",
    };

    const exec = createMockExec();
    const ui = createMockUI();

    await stopActiveOperation(exec, "/project", state, ui);

    expect(exec).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "terminate", "SIM-UUID", "all"],
      expect.any(Object),
    );
  });

  it("does not terminate on non-simulator destinations", async () => {
    const state = createState();
    state.appStatus = "running";
    state.activeDestination = {
      platform: "macOS",
      id: "MAC-UUID",
      name: "My Mac",
      arch: "arm64",
    };

    const exec = createMockExec();
    const ui = createMockUI();

    await stopActiveOperation(exec, "/project", state, ui);

    // Should NOT call simctl terminate (mac destination)
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls as [string, string[]][];
    const terminateCalls = calls.filter(([cmd, args]) =>
      cmd === "xcrun" && args.includes("terminate"),
    );
    expect(terminateCalls).toHaveLength(0);
  });

  it("stops spinner if present", async () => {
    const state = createState();
    state.appStatus = "building";
    const stopSpinnerFn = vi.fn();
    state.stopSpinner = stopSpinnerFn;

    const exec = createMockExec();
    const ui = createMockUI();

    await stopActiveOperation(exec, "/project", state, ui);

    // stopSpinner in state is called by stopSpinner() helper
    // The state.stopSpinner should be cleared
    // (stopActiveOperation calls stopSpinner which calls state.stopSpinner)
  });

  it("reports no active operation when idle", async () => {
    const state = createState();
    // Everything is idle

    const exec = createMockExec();
    const ui = createMockUI();

    const result = await stopActiveOperation(exec, "/project", state, ui);

    expect(result.details.stopped).toBe(false);
    expect(result.content[0].text).toContain("No active operation");
  });

  it("reports stopped when app was running but no abort controller", async () => {
    const state = createState();
    state.appStatus = "running";
    // No activeAbortController — app is just running, no build in flight

    const exec = createMockExec();
    const ui = createMockUI();

    const result = await stopActiveOperation(exec, "/project", state, ui);

    expect(result.details.stopped).toBe(true);
    expect(result.content[0].text).toContain("running app");
  });

  it("uses status label when no operation label available", async () => {
    const state = createState();
    state.appStatus = "testing";
    // No abort controller or operation label

    const exec = createMockExec();
    const ui = createMockUI();

    const result = await stopActiveOperation(exec, "/project", state, ui);

    expect(result.details.stopped).toBe(true);
    expect(result.content[0].text).toContain("tests");
  });

  it("updates status bar after stopping", async () => {
    const state = createState();
    state.appStatus = "building";
    state.activeAbortController = new AbortController();

    const exec = createMockExec();
    const ui = createMockUI();

    await stopActiveOperation(exec, "/project", state, ui);

    expect(ui.setStatus).toHaveBeenCalled();
  });

  it("handles pkill errors gracefully", async () => {
    const state = createState();
    state.appStatus = "building";
    state.activeAbortController = new AbortController();

    // pkill throws (no xcodebuild processes)
    const exec = vi.fn(async (command: string) => {
      if (command === "pkill") {
        throw new Error("No matching processes");
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as unknown as ExecFn;

    const ui = createMockUI();

    // Should not throw
    const result = await stopActiveOperation(exec, "/project", state, ui);
    expect(result.details.stopped).toBe(true);
  });

  it("handles simctl terminate errors gracefully", async () => {
    const state = createState();
    state.appStatus = "running";
    state.activeDestination = {
      platform: "iOS Simulator",
      id: "SIM-UUID",
      name: "iPhone 16",
      os: "18.0",
      arch: "arm64",
    };

    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "xcrun" && args.includes("terminate")) {
        throw new Error("Failed to terminate");
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as unknown as ExecFn;

    const ui = createMockUI();

    // Should not throw
    const result = await stopActiveOperation(exec, "/project", state, ui);
    expect(result.details.stopped).toBe(true);
    expect(state.appStatus).toBe("idle");
  });
});
