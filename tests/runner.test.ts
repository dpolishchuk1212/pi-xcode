import { describe, it, expect, vi } from "vitest";
import type { Destination, ExecFn, ExecResult } from "../src/types.js";
import {
  classifyDestination,
  terminateApp,
  ensureDestinationReady,
  installApp,
  launchApp,
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
  it("uses simctl launch for simulators", async () => {
    const exec = mockExec();
    const result = await launchApp(exec, simDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(true);
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

  it("uses open for macOS", async () => {
    const exec = mockExec();
    const result = await launchApp(exec, macDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledWith("open", ["/path/to/App.app"], expect.any(Object));
  });

  it("returns error on launch failure", async () => {
    const exec = mockExec({ launch: { code: 1, stderr: "launch failed" } });
    const result = await launchApp(exec, simDest, "com.test.App", "/path/to/App.app");
    expect(result.success).toBe(false);
    expect(result.error).toBe("launch failed");
  });
});
