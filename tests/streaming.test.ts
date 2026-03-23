import { describe, expect, it, vi } from "vitest";
import { createState } from "../src/state.js";
import { createBuildExec, createTestExec } from "../src/streaming.js";
import type { ExecFn, ExecResult } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockExec(stdout: string, stderr = ""): ExecFn {
  return vi.fn(async () => ({ stdout, stderr, code: 0, killed: false }));
}

function failExec(error: string): ExecFn {
  return vi.fn(async () => {
    throw new Error(error);
  }) as unknown as ExecFn;
}

// ── createBuildExec ────────────────────────────────────────────────────────

describe("createBuildExec", () => {
  it("counts completed build tasks from stdout", async () => {
    const state = createState();
    const output = [
      "CompileSwift normal arm64 /path/Foo.swift",
      "CompileSwift normal arm64 /path/Bar.swift",
      "CompileC normal arm64 /path/Baz.c",
      "Ld /path/to/binary",
      "CodeSign /path/to/App.app",
      "** BUILD SUCCEEDED **",
    ].join("\n");

    const exec = mockExec(output);
    const buildExec = createBuildExec(state, exec);
    await buildExec("xcodebuild", ["build"]);

    expect(state.completedTasks).toBe(5);
  });

  it("counts tasks from both stdout and stderr", async () => {
    const state = createState();
    const stdout = "CompileSwift normal arm64 /path/A.swift\n";
    const stderr = "CompileSwift normal arm64 /path/B.swift\n";

    const exec = mockExec(stdout, stderr);
    const buildExec = createBuildExec(state, exec);
    await buildExec("xcodebuild", ["build"]);

    expect(state.completedTasks).toBe(2);
  });

  it("resets counter on each invocation", async () => {
    const state = createState();
    state.completedTasks = 99;

    const exec = mockExec("CompileSwift normal arm64 /path/A.swift\n** BUILD SUCCEEDED **");
    const buildExec = createBuildExec(state, exec);
    await buildExec("xcodebuild", ["build"]);

    expect(state.completedTasks).toBe(1);
  });

  it("counts zero for output with no task lines", async () => {
    const state = createState();
    const exec = mockExec("random output\n** BUILD SUCCEEDED **");
    const buildExec = createBuildExec(state, exec);
    await buildExec("xcodebuild", ["build"]);

    expect(state.completedTasks).toBe(0);
  });

  it("recognizes all major task types", async () => {
    const state = createState();
    const tasks = [
      "CompileSwift normal arm64 /path",
      "CompileC normal arm64 /path",
      "SwiftCompile normal arm64 /path",
      "Ld /path/binary",
      "Link /path/binary",
      "MergeSwiftModule /path",
      "PhaseScriptExecution /path",
      "CopySwiftLibs /path",
      "ProcessInfoPlistFile /path",
      "CompileAssetCatalog /path",
      "CompileStoryboard /path",
      "CodeSign /path",
      "Validate /path",
      "CpResource /path",
      "CpHeader /path",
      "Copy /path",
      "ProcessProductPackaging /path",
      "ProcessProductPackagingDER /path",
      "GenerateAssetSymbols /path",
      "WriteAuxiliaryFile /path",
      "RegisterExecutionPolicyException /path",
      "CreateUniversalBinary /path",
      "SwiftDriver /path",
      "SwiftEmitModule /path",
      "SwiftMergeGeneratedHeaders /path",
      "EmitSwiftModule /path",
    ];

    const exec = mockExec(tasks.join("\n"));
    const buildExec = createBuildExec(state, exec);
    await buildExec("xcodebuild", ["build"]);

    expect(state.completedTasks).toBe(tasks.length);
  });

  it("does not count non-task lines as tasks", async () => {
    const state = createState();
    const output = [
      "Build description signature: abc123",
      "note: Using codesigning identity override",
      "/Users/dev/Foo.swift:10:5: error: bad stuff",
      "** BUILD FAILED **",
    ].join("\n");

    const exec = mockExec(output);
    const buildExec = createBuildExec(state, exec);
    await buildExec("xcodebuild", ["build"]);

    expect(state.completedTasks).toBe(0);
  });

  it("returns exec result unchanged", async () => {
    const state = createState();
    const exec = mockExec("** BUILD SUCCEEDED **");
    const buildExec = createBuildExec(state, exec);
    const result = await buildExec("xcodebuild", ["build"]);

    expect(result.stdout).toContain("BUILD SUCCEEDED");
    expect(result.code).toBe(0);
  });

  it("handles exec errors gracefully", async () => {
    const state = createState();
    const exec = failExec("xcodebuild crashed");
    const buildExec = createBuildExec(state, exec);
    const result = await buildExec("xcodebuild", ["build"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("xcodebuild crashed");
    expect(state.completedTasks).toBe(0);
  });

  it("resolves immediately on abort signal", async () => {
    const state = createState();
    const controller = new AbortController();
    controller.abort(); // Already aborted

    const exec = vi.fn(async () => {
      // Simulate a long-running build that never finishes
      await new Promise((r) => setTimeout(r, 10_000));
      return { stdout: "", stderr: "", code: 0, killed: false } as ExecResult;
    }) as ExecFn;

    const buildExec = createBuildExec(state, exec);
    const result = await buildExec("xcodebuild", ["build"], { signal: controller.signal });

    expect(result.code).toBe(1);
    expect(result.killed).toBe(true);
  });
});

// ── createTestExec ─────────────────────────────────────────────────────────

describe("createTestExec", () => {
  it("counts passed and failed tests", async () => {
    const state = createState();
    const output = [
      "Test case 'MyTests/testA()' passed on 'iPhone 16' (0.001 seconds).",
      "Test case 'MyTests/testB()' passed on 'iPhone 16' (0.002 seconds).",
      "Test case 'MyTests/testC()' failed on 'iPhone 16' (0.010 seconds).",
      "Test case 'MyTests/testD()' passed on 'iPhone 16' (0.001 seconds).",
    ].join("\n");

    const exec = mockExec(output);
    const testExec = createTestExec(state, exec);
    await testExec("xcodebuild", ["test"]);

    expect(state.passedTests).toBe(3);
    expect(state.failedTests).toBe(1);
  });

  it("resets counters on each invocation", async () => {
    const state = createState();
    state.passedTests = 50;
    state.failedTests = 10;

    const exec = mockExec("Test case 'S/testA()' passed on 'iPhone 16' (0.001 seconds).\n");
    const testExec = createTestExec(state, exec);
    await testExec("xcodebuild", ["test"]);

    expect(state.passedTests).toBe(1);
    expect(state.failedTests).toBe(0);
  });

  it("counts zero for output with no test results", async () => {
    const state = createState();
    const exec = mockExec("Compiling...\nLinking...\n");
    const testExec = createTestExec(state, exec);
    await testExec("xcodebuild", ["test"]);

    expect(state.passedTests).toBe(0);
    expect(state.failedTests).toBe(0);
  });

  it("counts from stderr as well", async () => {
    const state = createState();
    const stdout = "Test case 'S/testA()' passed on 'iPhone 16' (0.001 seconds).\n";
    const stderr = "Test case 'S/testB()' failed on 'iPhone 16' (0.001 seconds).\n";

    const exec = mockExec(stdout, stderr);
    const testExec = createTestExec(state, exec);
    await testExec("xcodebuild", ["test"]);

    expect(state.passedTests).toBe(1);
    expect(state.failedTests).toBe(1);
  });

  it("handles exec errors gracefully", async () => {
    const state = createState();
    const exec = failExec("test runner crashed");
    const testExec = createTestExec(state, exec);
    const result = await testExec("xcodebuild", ["test"]);

    expect(result.code).toBe(1);
    expect(state.passedTests).toBe(0);
    expect(state.failedTests).toBe(0);
  });

  it("handles Swift-style test case output", async () => {
    const state = createState();
    const output = [
      "Test case 'MyTests/testSwiftA()' passed on 'iPhone 16' (0.001 seconds).",
      "Test case 'MyTests/testSwiftB()' failed on 'iPhone 16' (0.002 seconds).",
    ].join("\n");

    const exec = mockExec(output);
    const testExec = createTestExec(state, exec);
    await testExec("xcodebuild", ["test"]);

    expect(state.passedTests).toBe(1);
    expect(state.failedTests).toBe(1);
  });
});
