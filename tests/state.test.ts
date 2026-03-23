import { describe, expect, it } from "vitest";
import { clearOperation, createState, startOperation } from "../src/state.js";

describe("createState", () => {
  it("returns fresh idle state with no selections", () => {
    const state = createState();
    expect(state.activeProject).toBeUndefined();
    expect(state.activeScheme).toBeUndefined();
    expect(state.availableSchemes).toEqual([]);
    expect(state.activeDestination).toBeUndefined();
    expect(state.availableDestinations).toEqual([]);
    expect(state.activeConfiguration).toBeUndefined();
    expect(state.availableConfigurations).toEqual([]);
    expect(state.appStatus).toBe("idle");
    expect(state.stopAppMonitor).toBeUndefined();
    expect(state.activeAbortController).toBeUndefined();
    expect(state.activeOperationLabel).toBeUndefined();
    expect(state.stopSpinner).toBeUndefined();
    expect(state.operationStartTime).toBeUndefined();
    expect(state.completedTasks).toBe(0);
    expect(state.passedTests).toBe(0);
    expect(state.failedTests).toBe(0);
  });

  it("creates independent state instances", () => {
    const a = createState();
    const b = createState();
    a.appStatus = "building";
    expect(b.appStatus).toBe("idle");
  });
});

describe("startOperation", () => {
  it("sets abort controller and label", () => {
    const state = createState();
    const signal = startOperation(state, "Build App");

    expect(state.activeAbortController).toBeDefined();
    expect(state.activeOperationLabel).toBe("Build App");
    expect(signal.aborted).toBe(false);
  });

  it("returns a working abort signal", () => {
    const state = createState();
    const signal = startOperation(state, "Build App");

    state.activeAbortController!.abort();
    expect(signal.aborted).toBe(true);
  });

  it("aborts previous operation when starting a new one", () => {
    const state = createState();
    const signal1 = startOperation(state, "Build 1");
    const signal2 = startOperation(state, "Build 2");

    expect(signal1.aborted).toBe(true);
    expect(signal2.aborted).toBe(false);
    expect(state.activeOperationLabel).toBe("Build 2");
  });

  it("combines with framework signal via AbortSignal.any", () => {
    const state = createState();
    const frameworkController = new AbortController();
    const signal = startOperation(state, "Build App", frameworkController.signal);

    expect(signal.aborted).toBe(false);

    // Framework abort should propagate
    frameworkController.abort();
    expect(signal.aborted).toBe(true);
  });

  it("combined signal fires when internal controller aborts", () => {
    const state = createState();
    const frameworkController = new AbortController();
    const signal = startOperation(state, "Build App", frameworkController.signal);

    state.activeAbortController!.abort();
    expect(signal.aborted).toBe(true);
    // Framework controller is not affected
    expect(frameworkController.signal.aborted).toBe(false);
  });

  it("returns internal signal when no framework signal provided", () => {
    const state = createState();
    const signal = startOperation(state, "Test run");

    // Signal should be from the internal controller
    state.activeAbortController!.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("clearOperation", () => {
  it("clears abort controller and label", () => {
    const state = createState();
    startOperation(state, "Build App");
    expect(state.activeAbortController).toBeDefined();
    expect(state.activeOperationLabel).toBe("Build App");

    clearOperation(state);
    expect(state.activeAbortController).toBeUndefined();
    expect(state.activeOperationLabel).toBeUndefined();
  });

  it("is safe to call when no operation is active", () => {
    const state = createState();
    clearOperation(state); // Should not throw
    expect(state.activeAbortController).toBeUndefined();
    expect(state.activeOperationLabel).toBeUndefined();
  });

  it("does not abort the signal (operation completed normally)", () => {
    const state = createState();
    const signal = startOperation(state, "Build App");
    clearOperation(state);

    // Signal should NOT be aborted — clearOperation means completion, not cancellation
    expect(signal.aborted).toBe(false);
  });
});
