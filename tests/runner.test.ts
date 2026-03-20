import { describe, it, expect, vi } from "vitest";
import type { Destination, ExecFn, ExecResult } from "../src/types.js";
import {
  classifyDestination,
  terminateApp,
  ensureDestinationReady,
  installApp,
  launchApp,
  monitorAppLifecycle,
  isProcessAlive,
  parsePidFromOutput,
  destinationTypeLabel,
} from "../src/runner.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockExec(responses?: Record<string, Partial<ExecResult>>): ExecFn {
  return vi.fn(async (command: string, args: string[]) => {
    const key = `${command} ${args.join(" ")}`;
    if (responses) {
      for (const [pattern, response] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          return { stdout: "", stderr: "", code: 0, killed: false, ...response };
        }
      }
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  });
}

const simDest: Destination = {
  platform: "iOS Simulator",
  id: "SIM-UUID",
  name: "iPhone 16",
  os: "18.0",
  arch: "arm64",
};

const deviceDest: Destination = {
  platform: "iOS",
  id: "DEV-UUID",
  name: "Dmytro's iPhone",
  os: "18.0",
  arch: "arm64",
};

const macDest: Destination = {
  platform: "macOS",
  id: "MAC-UUID",
  name: "My Mac",
  arch: "arm64",
};

const catalystDest: Destination = {
  platform: "macOS",
  id: "MAC-UUID",
  name: "My Mac",
  arch: "arm64",
  variant: "Mac Catalyst",
};

// ── classifyDestination ────────────────────────────────────────────────────

describe("classifyDestination", () => {
  it("classifies simulator", () => {
    expect(classifyDestination(simDest)).toBe("simulator");
  });

  it("classifies physical device", () => {
    expect(classifyDestination(deviceDest)).toBe("device");
  });

  it("classifies macOS", () => {
    expect(classifyDestination(macDest)).toBe("mac");
  });

  it("classifies Mac Catalyst as mac", () => {
    expect(classifyDestination(catalystDest)).toBe("mac");
  });

  it("classifies watchOS Simulator as simulator", () => {
    const dest: Destination = { platform: "watchOS Simulator", id: "W-UUID", name: "Apple Watch", os: "11.0" };
    expect(classifyDestination(dest)).toBe("simulator");
  });
});

// ── destinationTypeLabel ───────────────────────────────────────────────────

describe("destinationTypeLabel", () => {
  it("returns Simulator for simulator", () => {
    expect(destinationTypeLabel(simDest)).toBe("Simulator");
  });

  it("returns Device for physical device", () => {
    expect(destinationTypeLabel(deviceDest)).toBe("Device");
  });

  it("returns Mac for macOS", () => {
    expect(destinationTypeLabel(macDest)).toBe("Mac");
  });
});

// ── terminateApp ───────────────────────────────────────────────────────────

describe("terminateApp", () => {
  it("uses simctl terminate for simulators", async () => {
    const exec = mockExec();
    await terminateApp(exec, simDest, "com.test.App");
    expect(exec).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "terminate", "SIM-UUID", "com.test.App"],
      expect.any(Object),
    );
  });

  it("uses osascript for macOS", async () => {
    const exec = mockExec();
    await terminateApp(exec, macDest, "com.test.App");
    expect(exec).toHaveBeenCalledWith(
      "osascript",
      ["-e", 'tell application id "com.test.App" to quit'],
      expect.any(Object),
    );
  });

  it("does nothing for physical devices", async () => {
    const exec = mockExec();
    await terminateApp(exec, deviceDest, "com.test.App");
    expect(exec).not.toHaveBeenCalled();
  });

  it("ignores errors silently", async () => {
    const exec = mockExec({ terminate: { code: 1, stderr: "app not running" } });
    // Should not throw
    await terminateApp(exec, simDest, "com.test.App");
  });
});

// ── ensureDestinationReady ─────────────────────────────────────────────────

describe("ensureDestinationReady", () => {
  it("boots simulator and opens Simulator.app", async () => {
    const exec = mockExec();
    await ensureDestinationReady(exec, simDest);
    expect(exec).toHaveBeenCalledWith("xcrun", ["simctl", "boot", "SIM-UUID"], expect.any(Object));
    expect(exec).toHaveBeenCalledWith("open", ["-a", "Simulator"], expect.any(Object));
  });

  it("ignores boot error (already booted)", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes("boot")) {
        throw new Error("Already booted");
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    }) as ExecFn;

    // Should not throw
    await ensureDestinationReady(exec, simDest);
  });

  it("does nothing for macOS", async () => {
    const exec = mockExec();
    await ensureDestinationReady(exec, macDest);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does nothing for physical devices", async () => {
    const exec = mockExec();
    await ensureDestinationReady(exec, deviceDest);
    expect(exec).not.toHaveBeenCalled();
  });
});

// ── installApp ─────────────────────────────────────────────────────────────

describe("installApp", () => {
  it("uses simctl install for simulators", async () => {
    const exec = mockExec();
    await installApp(exec, simDest, "/path/to/App.app");
    expect(exec).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "install", "SIM-UUID", "/path/to/App.app"],
      expect.any(Object),
    );
  });

  it("uses devicectl for physical devices", async () => {
    const exec = mockExec();
    await installApp(exec, deviceDest, "/path/to/App.app");
    expect(exec).toHaveBeenCalledWith(
      "xcrun",
      ["devicectl", "device", "install", "app", "--device", "DEV-UUID", "/path/to/App.app"],
      expect.any(Object),
    );
  });

  it("does nothing for macOS", async () => {
    const exec = mockExec();
    await installApp(exec, macDest, "/path/to/App.app");
    expect(exec).not.toHaveBeenCalled();
  });
});

// ── launchApp ──────────────────────────────────────────────────────────────

describe("launchApp", () => {
  it("uses simctl launch for simulators and parses PID", async () => {
    const exec = mockExec({ launch: { stdout: "com.test.App: 12345\n" } });
    const result = await launchApp(exec, simDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(true);
    expect(result.pid).toBe(12345);
    expect(exec).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", "SIM-UUID", "com.test.App"],
      expect.any(Object),
    );
  });

  it("uses devicectl for physical devices", async () => {
    const exec = mockExec();
    const result = await launchApp(exec, deviceDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "xcrun",
      ["devicectl", "device", "process", "launch", "--device", "DEV-UUID", "com.test.App"],
      expect.any(Object),
    );
  });

  it("uses open for macOS and finds PID via pgrep", async () => {
    const exec = mockExec({ pgrep: { stdout: "67890\n" } });
    const result = await launchApp(exec, macDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(true);
    expect(result.pid).toBe(67890);
  });

  it("returns error on launch failure", async () => {
    const exec = mockExec({ launch: { code: 1, stderr: "launch failed" } });
    const result = await launchApp(exec, simDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(false);
    expect(result.error).toBe("launch failed");
  });

  it("returns undefined PID when simctl output has no PID", async () => {
    const exec = mockExec({ launch: { stdout: "" } });
    const result = await launchApp(exec, simDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(true);
    expect(result.pid).toBeUndefined();
  });
});

// ── parsePidFromOutput ─────────────────────────────────────────────────────

describe("parsePidFromOutput", () => {
  it("parses simctl launch format", () => {
    expect(parsePidFromOutput("com.example.App: 12345\n")).toBe(12345);
  });

  it("parses PID with extra whitespace", () => {
    expect(parsePidFromOutput("com.example.App:  99999 \n")).toBe(99999);
  });

  it("parses devicectl-style pid output", () => {
    expect(parsePidFromOutput('pid: 54321')).toBe(54321);
  });

  it("returns undefined for no PID", () => {
    expect(parsePidFromOutput("no pid here")).toBeUndefined();
    expect(parsePidFromOutput("")).toBeUndefined();
  });
});

// ── isProcessAlive ─────────────────────────────────────────────────────────

describe("isProcessAlive", () => {
  it("returns true when ps succeeds", async () => {
    const exec = mockExec({ ps: { code: 0 } });
    expect(await isProcessAlive(exec, 12345)).toBe(true);
    expect(exec).toHaveBeenCalledWith("ps", ["-p", "12345"], expect.any(Object));
  });

  it("returns false when ps fails", async () => {
    const exec = mockExec({ ps: { code: 1 } });
    expect(await isProcessAlive(exec, 12345)).toBe(false);
  });

  it("returns false on exec error", async () => {
    const exec = vi.fn(async () => { throw new Error("exec failed"); }) as unknown as ExecFn;
    expect(await isProcessAlive(exec, 12345)).toBe(false);
  });
});

// ── monitorAppLifecycle ────────────────────────────────────────────────────

describe("monitorAppLifecycle", () => {
  it("calls onExit when process dies", async () => {
    let callCount = 0;
    const exec = vi.fn(async () => {
      callCount++;
      // Process alive on first check, dead on second
      return { stdout: "", stderr: "", code: callCount <= 1 ? 0 : 1, killed: false };
    }) as unknown as ExecFn;

    const onExit = vi.fn();
    const stop = monitorAppLifecycle(exec, 12345, onExit, 50); // 50ms interval for fast test

    // Wait for a few cycles
    await new Promise((r) => setTimeout(r, 200));
    stop();

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("stops polling when cleanup is called", async () => {
    const exec = mockExec({ ps: { code: 0 } }); // always alive
    const onExit = vi.fn();

    const stop = monitorAppLifecycle(exec, 12345, onExit, 50);

    // Let it poll a couple times
    await new Promise((r) => setTimeout(r, 130));
    stop();

    // Wait to ensure no more polls happen
    const callCountAtStop = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountAtStop);

    expect(onExit).not.toHaveBeenCalled();
  });

  it("does not call onExit multiple times", async () => {
    const exec = mockExec({ ps: { code: 1 } }); // always dead
    const onExit = vi.fn();

    const stop = monitorAppLifecycle(exec, 12345, onExit, 50);

    await new Promise((r) => setTimeout(r, 250));
    stop();

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
