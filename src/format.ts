import type { BuildResult, TestResult } from "./types.js";

/**
 * Format a build result into a human-readable string for the LLM.
 */
export function formatBuildResult(result: BuildResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✅ BUILD SUCCEEDED");
  } else {
    lines.push("❌ BUILD FAILED");
  }

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  if (errors.length > 0) {
    lines.push("");
    lines.push(`Errors (${errors.length}):`);
    for (const e of errors) {
      lines.push(`  ${e.file}:${e.line}:${e.column}: ${e.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${warnings.length}):`);
    for (const w of warnings) {
      lines.push(`  ${w.file}:${w.line}:${w.column}: ${w.message}`);
    }
  }

  if (errors.length === 0 && warnings.length === 0 && result.success) {
    lines.push("No issues found.");
  }

  return lines.join("\n");
}

/**
 * Format a test result into a human-readable string for the LLM.
 */
export function formatTestResult(result: TestResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(`✅ ALL TESTS PASSED (${result.total} tests, ${result.duration.toFixed(3)}s)`);
  } else {
    lines.push(`❌ TESTS FAILED (${result.failed}/${result.total} failed, ${result.duration.toFixed(3)}s)`);
  }

  // Show failed tests first
  const failedCases = result.cases.filter((c) => !c.passed);
  if (failedCases.length > 0) {
    lines.push("");
    lines.push("Failed tests:");
    for (const tc of failedCases) {
      lines.push(`  ✗ ${tc.suite}.${tc.name} (${tc.duration.toFixed(3)}s)`);
      if (tc.failureMessage) {
        lines.push(`    ${tc.failureMessage}`);
      }
    }
  }

  // Summary of passed tests (compact)
  const passedCases = result.cases.filter((c) => c.passed);
  if (passedCases.length > 0) {
    lines.push("");
    lines.push(`Passed tests (${passedCases.length}):`);
    for (const tc of passedCases) {
      lines.push(`  ✓ ${tc.suite}.${tc.name} (${tc.duration.toFixed(3)}s)`);
    }
  }

  return lines.join("\n");
}
