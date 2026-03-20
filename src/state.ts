import type { Destination, Simulator, XcodeProject, XcodeScheme } from "./types.js";

/**
 * Shared mutable state for the extension session.
 * Tools and commands read/write this to coordinate.
 */
export interface XcodeState {
  activeSimulator: Simulator | undefined;
  activeProject: XcodeProject | undefined;
  activeScheme: XcodeScheme | undefined;
  availableDestinations: Destination[];
  activeDestination: Destination | undefined;
}

export function createState(): XcodeState {
  return {
    activeSimulator: undefined,
    activeProject: undefined,
    activeScheme: undefined,
    availableDestinations: [],
    activeDestination: undefined,
  };
}
