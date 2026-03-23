import { describe, expect, it } from "vitest";
import { pickBestDestination, pickBestScheme, projectBaseName } from "../src/auto-select.js";
import type { Destination, XcodeScheme } from "../src/types.js";

// ── pickBestScheme ─────────────────────────────────────────────────────────

describe("pickBestScheme", () => {
  it("returns undefined for empty list", () => {
    expect(pickBestScheme([])).toBeUndefined();
  });

  it("returns the only scheme when there is one", () => {
    const schemes: XcodeScheme[] = [{ name: "App", project: "/p" }];
    expect(pickBestScheme(schemes)?.name).toBe("App");
  });

  it("prefers app scheme over others", () => {
    const schemes: XcodeScheme[] = [
      { name: "AppTests", project: "/p", productType: "test" },
      { name: "AppFramework", project: "/p", productType: "framework" },
      { name: "App", project: "/p", productType: "app" },
    ];
    expect(pickBestScheme(schemes)?.name).toBe("App");
  });

  it("prefers app scheme matching project name", () => {
    const schemes: XcodeScheme[] = [
      { name: "OtherApp", project: "/p", productType: "app" },
      { name: "MyProject", project: "/p", productType: "app" },
    ];
    expect(pickBestScheme(schemes, "MyProject")?.name).toBe("MyProject");
  });

  it("falls back to first app scheme when no name match", () => {
    const schemes: XcodeScheme[] = [
      { name: "Alpha", project: "/p", productType: "app" },
      { name: "Beta", project: "/p", productType: "app" },
    ];
    expect(pickBestScheme(schemes, "NonExistent")?.name).toBe("Alpha");
  });

  it("prefers extension scheme when no app schemes", () => {
    const schemes: XcodeScheme[] = [
      { name: "MyTests", project: "/p", productType: "test" },
      { name: "MyExtension", project: "/p", productType: "extension" },
      { name: "MyFramework", project: "/p", productType: "framework" },
    ];
    expect(pickBestScheme(schemes)?.name).toBe("MyExtension");
  });

  it("excludes test and framework by name when productType is unknown", () => {
    const schemes: XcodeScheme[] = [
      { name: "MyAppTests", project: "/p" },
      { name: "MyFramework", project: "/p" },
      { name: "MyApp", project: "/p" },
    ];
    expect(pickBestScheme(schemes)?.name).toBe("MyApp");
  });

  it("matches project name in fallback (non-test/non-framework)", () => {
    const schemes: XcodeScheme[] = [
      { name: "CLI", project: "/p" },
      { name: "Letyco", project: "/p" },
    ];
    expect(pickBestScheme(schemes, "Letyco")?.name).toBe("Letyco");
  });

  it("falls back to first scheme as last resort", () => {
    const schemes: XcodeScheme[] = [
      { name: "SomeTest", project: "/p", productType: "test" },
      { name: "AnotherTest", project: "/p", productType: "test" },
    ];
    // All are test schemes — name heuristic excludes them too, so last resort
    expect(pickBestScheme(schemes)?.name).toBe("SomeTest");
  });
});

// ── pickBestDestination ────────────────────────────────────────────────────

describe("pickBestDestination", () => {
  it("returns undefined for empty list", () => {
    expect(pickBestDestination([])).toBeUndefined();
  });

  it("prefers iPhone simulator over iPad and Mac", () => {
    const dests: Destination[] = [
      { platform: "macOS", id: "MAC", name: "My Mac", arch: "arm64" },
      { platform: "iOS Simulator", id: "IPAD", name: "iPad Air", os: "18.0", arch: "arm64" },
      { platform: "iOS Simulator", id: "IP16", name: "iPhone 16", os: "18.0", arch: "arm64" },
    ];
    expect(pickBestDestination(dests)?.name).toBe("iPhone 16");
  });

  it("prefers latest OS version among iPhones", () => {
    const dests: Destination[] = [
      { platform: "iOS Simulator", id: "A", name: "iPhone 15", os: "17.5", arch: "arm64" },
      { platform: "iOS Simulator", id: "B", name: "iPhone 16", os: "18.0", arch: "arm64" },
      { platform: "iOS Simulator", id: "C", name: "iPhone 17", os: "26.0", arch: "arm64" },
    ];
    expect(pickBestDestination(dests)?.name).toBe("iPhone 17");
  });

  it("falls back to iPad when no iPhones", () => {
    const dests: Destination[] = [
      { platform: "macOS", id: "MAC", name: "My Mac", arch: "arm64" },
      { platform: "iOS Simulator", id: "IPAD", name: "iPad Pro", os: "18.0", arch: "arm64" },
    ];
    expect(pickBestDestination(dests)?.name).toBe("iPad Pro");
  });

  it("falls back to any simulator when no iPhone/iPad", () => {
    const dests: Destination[] = [
      { platform: "macOS", id: "MAC", name: "My Mac", arch: "arm64" },
      { platform: "watchOS Simulator", id: "WATCH", name: "Apple Watch", os: "11.0", arch: "arm64" },
    ];
    expect(pickBestDestination(dests)?.name).toBe("Apple Watch");
  });

  it("falls back to non-simulator when no simulators", () => {
    const dests: Destination[] = [{ platform: "macOS", id: "MAC", name: "My Mac", arch: "arm64" }];
    expect(pickBestDestination(dests)?.name).toBe("My Mac");
  });

  it("skips placeholder destinations", () => {
    const dests: Destination[] = [
      { platform: "iOS", id: "dvtdevice-placeholder", name: "Any iOS Device" },
      { platform: "iOS Simulator", id: "SIM", name: "iPhone 16", os: "18.0", arch: "arm64" },
    ];
    expect(pickBestDestination(dests)?.name).toBe("iPhone 16");
  });

  it("returns placeholder when it's the only option", () => {
    const dests: Destination[] = [{ platform: "iOS", id: "dvtdevice-placeholder", name: "Any iOS Device" }];
    // All real destinations filtered → falls back to first item
    expect(pickBestDestination(dests)?.name).toBe("Any iOS Device");
  });
});

// ── projectBaseName ────────────────────────────────────────────────────────

describe("projectBaseName", () => {
  it("strips .xcworkspace extension", () => {
    expect(projectBaseName("/path/to/Letyco.xcworkspace")).toBe("Letyco");
  });

  it("strips .xcodeproj extension", () => {
    expect(projectBaseName("/path/to/MyApp.xcodeproj")).toBe("MyApp");
  });

  it("strips .swift extension", () => {
    expect(projectBaseName("/path/to/Package.swift")).toBe("Package");
  });

  it("handles just filename without path", () => {
    expect(projectBaseName("App.xcodeproj")).toBe("App");
  });

  it("handles nested paths", () => {
    expect(projectBaseName("/Users/dev/Projects/Cool/Cool.xcworkspace")).toBe("Cool");
  });

  it("returns full basename for unknown extension", () => {
    expect(projectBaseName("/path/to/Something.txt")).toBe("Something.txt");
  });
});
