import type { Simulator } from "./types.js";

/**
 * Shared mutable state for the extension session.
 * Tools and commands read/write this to coordinate.
 */
export interface XcodeState {
  activeSimulator: Simulator | undefined;
}

export function createState(): XcodeState {
  return {
    activeSimulator: undefined,
  };
}
