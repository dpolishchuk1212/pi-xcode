import { describe, expect, it } from "vitest";
import { formatBuildResult, formatTestResult } from "../src/format.js";
import type { BuildResult, TestResult } from "../src/types.js";

describe("formatBuildResult", () => {
  it("formats successful build with no issues", () => {
    const result: BuildResult = { success: true, issues: [], rawOutput: "" };
    const text = formatBuildResult(result);
    expect(text).toContain("✅ BUILD SUCCEEDED");
    expect(text).toContain("No issues found");
  });

  it("formats successful build with warnings", () => {
    const result: BuildResult = {
      success: true,
      issues: [{ file: "/f.swift", line: 10, column: 5, severity: "warning", message: "unused" }],
      rawOutput: "",
    };
    const text = formatBuildResult(result);
    expect(text).toContain("✅ BUILD SUCCEEDED");
    expect(text).toContain("Warnings (1)");
    expect(text).toContain("/f.swift:10:5: unused");
  });

  it("formats failed build with errors", () => {
    const result: BuildResult = {
      success: false,
      issues: [
        { file: "/a.swift", line: 1, column: 1, severity: "error", message: "bad" },
        { file: "/b.swift", line: 2, column: 2, severity: "error", message: "worse" },
      ],
      rawOutput: "",
    };
    const text = formatBuildResult(result);
    expect(text).toContain("❌ BUILD FAILED");
    expect(text).toContain("Errors (2)");
  });
});

describe("formatTestResult", () => {
  it("formats all-passing result", () => {
    const result: TestResult = {
      success: true,
      passed: 3,
      failed: 0,
      total: 3,
      duration: 0.05,
      cases: [
        { suite: "S", name: "testA", passed: true, duration: 0.01 },
        { suite: "S", name: "testB", passed: true, duration: 0.02 },
        { suite: "S", name: "testC", passed: true, duration: 0.02 },
      ],
      rawOutput: "",
    };
    const text = formatTestResult(result);
    expect(text).toContain("✅ ALL TESTS PASSED");
    expect(text).toContain("3 tests");
    expect(text).toContain("Passed tests (3)");
    expect(text).not.toContain("Failed tests");
  });

  it("formats result with failures", () => {
    const result: TestResult = {
      success: false,
      passed: 1,
      failed: 1,
      total: 2,
      duration: 0.03,
      cases: [
        { suite: "S", name: "testOk", passed: true, duration: 0.01 },
        { suite: "S", name: "testBad", passed: false, duration: 0.02, failureMessage: "XCTAssertTrue failed" },
      ],
      rawOutput: "",
    };
    const text = formatTestResult(result);
    expect(text).toContain("❌ TESTS FAILED");
    expect(text).toContain("1/2 failed");
    expect(text).toContain("✗ S.testBad");
    expect(text).toContain("XCTAssertTrue failed");
    expect(text).toContain("✓ S.testOk");
  });
});
