import { describe, expect, it } from "vitest";
import {
  buildBaseArgs,
  buildBuildArgs,
  buildCleanArgs,
  buildListArgs,
  buildShowSettingsArgs,
  buildSimctlBootArgs,
  buildSimctlInstallArgs,
  buildSimctlLaunchArgs,
  buildSimctlListArgs,
  buildSimulatorDestination,
  buildTestArgs,
} from "../src/commands.js";

// ── Base args ──────────────────────────────────────────────────────────────

describe("buildBaseArgs", () => {
  it("builds args with workspace", () => {
    const args = buildBaseArgs({ workspace: "App.xcworkspace", scheme: "App" });
    expect(args).toEqual(["-workspace", "App.xcworkspace", "-scheme", "App"]);
  });

  it("builds args with project", () => {
    const args = buildBaseArgs({ project: "App.xcodeproj", scheme: "App" });
    expect(args).toEqual(["-project", "App.xcodeproj", "-scheme", "App"]);
  });

  it("prefers workspace over project", () => {
    const args = buildBaseArgs({
      workspace: "App.xcworkspace",
      project: "App.xcodeproj",
      scheme: "App",
    });
    expect(args).toEqual(["-workspace", "App.xcworkspace", "-scheme", "App"]);
  });

  it("includes configuration", () => {
    const args = buildBaseArgs({ project: "App.xcodeproj", configuration: "Release" });
    expect(args).toEqual(["-project", "App.xcodeproj", "-configuration", "Release"]);
  });

  it("includes destination", () => {
    const args = buildBaseArgs({
      project: "App.xcodeproj",
      destination: "platform=iOS Simulator,name=iPhone 16",
    });
    expect(args).toContain("-destination");
    expect(args).toContain("platform=iOS Simulator,name=iPhone 16");
  });

  it("includes sdk", () => {
    const args = buildBaseArgs({ project: "App.xcodeproj", sdk: "iphonesimulator" });
    expect(args).toContain("-sdk");
    expect(args).toContain("iphonesimulator");
  });

  it("appends extra args", () => {
    const args = buildBaseArgs({
      project: "App.xcodeproj",
      extraArgs: ["-quiet", "ONLY_ACTIVE_ARCH=YES"],
    });
    expect(args).toContain("-quiet");
    expect(args).toContain("ONLY_ACTIVE_ARCH=YES");
  });

  it("returns empty for no options", () => {
    expect(buildBaseArgs({})).toEqual([]);
  });
});

// ── Action args ────────────────────────────────────────────────────────────

describe("buildBuildArgs", () => {
  it("appends build action", () => {
    const args = buildBuildArgs({ project: "App.xcodeproj", scheme: "App" });
    expect(args).toEqual(["-project", "App.xcodeproj", "-scheme", "App", "build"]);
  });
});

describe("buildCleanArgs", () => {
  it("appends clean action", () => {
    const args = buildCleanArgs({ project: "App.xcodeproj", scheme: "App" });
    expect(args).toEqual(["-project", "App.xcodeproj", "-scheme", "App", "clean"]);
  });
});

describe("buildTestArgs", () => {
  it("appends test action", () => {
    const args = buildTestArgs({ project: "App.xcodeproj", scheme: "AppTests" });
    expect(args).toEqual(["-project", "App.xcodeproj", "-scheme", "AppTests", "test"]);
  });

  it("includes testPlan", () => {
    const args = buildTestArgs({ project: "App.xcodeproj", scheme: "App", testPlan: "MyPlan" });
    expect(args).toContain("-testPlan");
    expect(args).toContain("MyPlan");
  });

  it("includes onlyTesting filters", () => {
    const args = buildTestArgs({
      project: "App.xcodeproj",
      scheme: "App",
      onlyTesting: ["MyTests/testA", "MyTests/testB"],
    });
    expect(args.filter((a) => a === "-only-testing")).toHaveLength(2);
    expect(args).toContain("MyTests/testA");
    expect(args).toContain("MyTests/testB");
  });

  it("includes skipTesting filters", () => {
    const args = buildTestArgs({
      project: "App.xcodeproj",
      scheme: "App",
      skipTesting: ["SlowTests"],
    });
    expect(args).toContain("-skip-testing");
    expect(args).toContain("SlowTests");
  });
});

describe("buildShowSettingsArgs", () => {
  it("appends -showBuildSettings", () => {
    const args = buildShowSettingsArgs({ project: "App.xcodeproj", scheme: "App" });
    expect(args[args.length - 1]).toBe("-showBuildSettings");
  });
});

describe("buildListArgs", () => {
  it("uses -project for .xcodeproj", () => {
    const args = buildListArgs("App.xcodeproj");
    expect(args).toEqual(["-list", "-project", "App.xcodeproj"]);
  });

  it("uses -workspace for .xcworkspace", () => {
    const args = buildListArgs("App.xcworkspace");
    expect(args).toEqual(["-list", "-workspace", "App.xcworkspace"]);
  });
});

// ── simctl args ────────────────────────────────────────────────────────────

describe("buildSimctlListArgs", () => {
  it("builds correct args", () => {
    expect(buildSimctlListArgs()).toEqual(["simctl", "list", "devices", "available", "--json"]);
  });
});

describe("buildSimctlBootArgs", () => {
  it("builds boot args", () => {
    expect(buildSimctlBootArgs("UDID-123")).toEqual(["simctl", "boot", "UDID-123"]);
  });
});

describe("buildSimctlInstallArgs", () => {
  it("builds install args", () => {
    expect(buildSimctlInstallArgs("UDID-123", "/path/App.app")).toEqual([
      "simctl",
      "install",
      "UDID-123",
      "/path/App.app",
    ]);
  });
});

describe("buildSimctlLaunchArgs", () => {
  it("builds launch args", () => {
    expect(buildSimctlLaunchArgs("UDID-123", "com.example.app")).toEqual([
      "simctl",
      "launch",
      "UDID-123",
      "com.example.app",
    ]);
  });

  it("includes -w for debugger wait", () => {
    const args = buildSimctlLaunchArgs("UDID-123", "com.example.app", true);
    expect(args).toContain("-w");
  });
});

// ── Destination builder ────────────────────────────────────────────────────

describe("buildSimulatorDestination", () => {
  it("uses id= for UDID format", () => {
    expect(buildSimulatorDestination("A1B2C3D4-E5F6-7890-ABCD-EF0123456789")).toBe(
      "platform=iOS Simulator,id=A1B2C3D4-E5F6-7890-ABCD-EF0123456789",
    );
  });

  it("uses name= for non-UDID strings", () => {
    expect(buildSimulatorDestination("iPhone 16")).toBe("platform=iOS Simulator,name=iPhone 16");
  });
});
