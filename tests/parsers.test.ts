import { describe, it, expect } from "vitest";
import {
  parseBuildIssues,
  parseBuildSuccess,
  parseBuildResult,
  parseTestCases,
  parseTestResult,
  parseSchemeList,
  parseSimulatorList,
  parseBundleId,
  parseAppPath,
} from "../src/parsers.js";

// ── Build issue parsing ────────────────────────────────────────────────────

describe("parseBuildIssues", () => {
  it("parses errors from xcodebuild output", () => {
    const output = `/Users/dev/App/ViewController.swift:42:10: error: use of unresolved identifier 'foo'
/Users/dev/App/Model.swift:18:5: error: missing return in a function expected to return 'String'`;

    const issues = parseBuildIssues(output);
    expect(issues).toHaveLength(2);

    expect(issues[0]).toEqual({
      file: "/Users/dev/App/ViewController.swift",
      line: 42,
      column: 10,
      severity: "error",
      message: "use of unresolved identifier 'foo'",
    });

    expect(issues[1]).toEqual({
      file: "/Users/dev/App/Model.swift",
      line: 18,
      column: 5,
      severity: "error",
      message: "missing return in a function expected to return 'String'",
    });
  });

  it("parses warnings", () => {
    const output = `/Users/dev/App/ViewController.swift:10:5: warning: variable 'x' was never used`;

    const issues = parseBuildIssues(output);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toBe("variable 'x' was never used");
  });

  it("parses notes", () => {
    const output = `/Users/dev/App/Protocol.swift:5:10: note: protocol requires function 'doSomething()'`;

    const issues = parseBuildIssues(output);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("note");
  });

  it("deduplicates identical issues", () => {
    const output = `/Users/dev/App/Foo.swift:10:5: error: something
/Users/dev/App/Foo.swift:10:5: error: something
/Users/dev/App/Foo.swift:10:5: error: something`;

    const issues = parseBuildIssues(output);
    expect(issues).toHaveLength(1);
  });

  it("handles mixed output with non-diagnostic lines", () => {
    const output = `CompileSwift normal arm64 /Users/dev/App/Foo.swift
/Users/dev/App/Foo.swift:10:5: error: bad stuff
note: blah
Build step finished`;

    const issues = parseBuildIssues(output);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("returns empty array for clean build", () => {
    const output = `** BUILD SUCCEEDED **`;
    expect(parseBuildIssues(output)).toEqual([]);
  });
});

describe("parseBuildSuccess", () => {
  it("detects success", () => {
    expect(parseBuildSuccess("stuff\n** BUILD SUCCEEDED **\n")).toBe(true);
  });

  it("detects failure", () => {
    expect(parseBuildSuccess("stuff\n** BUILD FAILED **\n")).toBe(false);
  });

  it("returns false on empty output", () => {
    expect(parseBuildSuccess("")).toBe(false);
  });
});

describe("parseBuildResult", () => {
  it("combines success and issues", () => {
    const output = `/Users/dev/Foo.swift:10:5: warning: unused
** BUILD SUCCEEDED **`;

    const result = parseBuildResult(output);
    expect(result.success).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.rawOutput).toBe(output);
  });

  it("handles failed build with errors", () => {
    const output = `/Users/dev/Foo.swift:10:5: error: bad
** BUILD FAILED **`;

    const result = parseBuildResult(output);
    expect(result.success).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("error");
  });
});

// ── Test result parsing ────────────────────────────────────────────────────

describe("parseTestCases", () => {
  it("parses ObjC-style test case results", () => {
    const output = `Test Case '-[MyTests testAddition]' passed (0.003 seconds).
Test Case '-[MyTests testSubtraction]' failed (0.012 seconds).`;

    const cases = parseTestCases(output);
    expect(cases).toHaveLength(2);

    expect(cases[0]).toEqual({
      suite: "MyTests",
      name: "testAddition",
      passed: true,
      duration: 0.003,
      failureMessage: undefined,
    });

    expect(cases[1]).toEqual({
      suite: "MyTests",
      name: "testSubtraction",
      passed: false,
      duration: 0.012,
      failureMessage: undefined,
    });
  });

  it("parses Swift-style test case results", () => {
    const output = `Test Case 'MyTests.testSwiftStyle' passed (0.001 seconds).`;

    const cases = parseTestCases(output);
    expect(cases).toHaveLength(1);
    expect(cases[0].suite).toBe("MyTests");
    expect(cases[0].name).toBe("testSwiftStyle");
  });

  it("captures failure messages", () => {
    const output = `/Users/dev/Tests.swift:42: error: -[MyTests testFoo] : XCTAssertEqual failed: ("1") is not equal to ("2")
Test Case '-[MyTests testFoo]' failed (0.005 seconds).`;

    const cases = parseTestCases(output);
    expect(cases).toHaveLength(1);
    expect(cases[0].passed).toBe(false);
    expect(cases[0].failureMessage).toBe('XCTAssertEqual failed: ("1") is not equal to ("2")');
  });

  it("returns empty for no test output", () => {
    expect(parseTestCases("random stuff\nno tests here")).toEqual([]);
  });
});

describe("parseTestResult", () => {
  it("parses full test output with summary", () => {
    const output = `Test Case '-[MyTests testA]' passed (0.001 seconds).
Test Case '-[MyTests testB]' passed (0.002 seconds).
Test Case '-[MyTests testC]' failed (0.010 seconds).
Executed 3 tests, with 1 failure (0 unexpected) in 0.013 (0.025) seconds`;

    const result = parseTestResult(output);
    expect(result.success).toBe(false);
    expect(result.total).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.duration).toBe(0.013);
    expect(result.cases).toHaveLength(3);
  });

  it("parses all-passing output", () => {
    const output = `Test Case '-[MyTests testA]' passed (0.001 seconds).
Test Case '-[MyTests testB]' passed (0.002 seconds).
Executed 2 tests, with 0 failures (0 unexpected) in 0.003 (0.010) seconds`;

    const result = parseTestResult(output);
    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("falls back to case counting when no summary line", () => {
    const output = `Test Case '-[MyTests testA]' passed (0.001 seconds).
Test Case '-[MyTests testB]' failed (0.002 seconds).`;

    const result = parseTestResult(output);
    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
  });
});

// ── Scheme list parsing ────────────────────────────────────────────────────

describe("parseSchemeList", () => {
  it("parses xcodebuild -list output", () => {
    const output = `Information about project "MyApp":
    Targets:
        MyApp
        MyAppTests

    Build Configurations:
        Debug
        Release

    If no build configuration is specified and -scheme is not passed then "Release" is used.

    Schemes:
        MyApp
        MyAppTests`;

    const schemes = parseSchemeList(output, "/path/to/MyApp.xcodeproj");
    expect(schemes).toHaveLength(2);
    expect(schemes[0]).toEqual({ name: "MyApp", project: "/path/to/MyApp.xcodeproj" });
    expect(schemes[1]).toEqual({ name: "MyAppTests", project: "/path/to/MyApp.xcodeproj" });
  });

  it("returns empty for output without schemes section", () => {
    const output = `Information about project "MyApp":
    Targets:
        MyApp`;

    expect(parseSchemeList(output, "/path")).toEqual([]);
  });

  it("handles single scheme", () => {
    const output = `    Schemes:
        OnlyScheme
`;

    const schemes = parseSchemeList(output, "/path");
    expect(schemes).toHaveLength(1);
    expect(schemes[0].name).toBe("OnlyScheme");
  });
});

// ── Simulator list parsing ─────────────────────────────────────────────────

describe("parseSimulatorList", () => {
  it("parses simctl JSON output", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          { udid: "AAAA-BBBB-CCCC-DDDD", name: "iPhone 16", state: "Shutdown", isAvailable: true },
          { udid: "EEEE-FFFF-0000-1111", name: "iPhone 16 Pro", state: "Booted", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          { udid: "2222-3333-4444-5555", name: "iPhone 15", state: "Shutdown", isAvailable: true },
          { udid: "6666-7777-8888-9999", name: "Unavailable", state: "Shutdown", isAvailable: false },
        ],
      },
    });

    const sims = parseSimulatorList(json);
    expect(sims).toHaveLength(3); // excludes unavailable

    expect(sims[0]).toEqual({
      udid: "AAAA-BBBB-CCCC-DDDD",
      name: "iPhone 16",
      runtime: "iOS.18.0",
      state: "Shutdown",
      isAvailable: true,
    });

    expect(sims[1].name).toBe("iPhone 16 Pro");
    expect(sims[1].state).toBe("Booted");
    expect(sims[2].runtime).toBe("iOS.17.5");
  });

  it("returns empty for invalid JSON", () => {
    expect(parseSimulatorList("not json")).toEqual([]);
  });

  it("returns empty for missing devices key", () => {
    expect(parseSimulatorList(JSON.stringify({}))).toEqual([]);
  });
});

// ── Bundle ID / App path parsing ───────────────────────────────────────────

describe("parseBundleId", () => {
  it("extracts bundle identifier from build settings", () => {
    const output = `    PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp
    PRODUCT_NAME = MyApp`;

    expect(parseBundleId(output)).toBe("com.example.MyApp");
  });

  it("returns undefined when not found", () => {
    expect(parseBundleId("no bundle id here")).toBeUndefined();
  });
});

describe("parseAppPath", () => {
  it("constructs app path from build settings", () => {
    const output = `    BUILT_PRODUCTS_DIR = /Users/dev/Library/Developer/Xcode/DerivedData/MyApp-abc/Build/Products/Debug-iphonesimulator
    FULL_PRODUCT_NAME = MyApp.app`;

    const appPath = parseAppPath(output);
    expect(appPath).toBe(
      "/Users/dev/Library/Developer/Xcode/DerivedData/MyApp-abc/Build/Products/Debug-iphonesimulator/MyApp.app",
    );
  });

  it("returns undefined when parts are missing", () => {
    expect(parseAppPath("BUILT_PRODUCTS_DIR = /some/path")).toBeUndefined();
    expect(parseAppPath("FULL_PRODUCT_NAME = Foo.app")).toBeUndefined();
    expect(parseAppPath("nothing useful")).toBeUndefined();
  });
});
