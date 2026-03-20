import type { Destination, XcodeProject, XcodeScheme } from "./types.js";

/**
 * Shared mutable state for the extension session.
 * Tools and commands read/write this to coordinate.
 */
export interface XcodeState {
  activeProject: XcodeProject | undefined;
  activeScheme: XcodeScheme | undefined;
  availableSchemes: XcodeScheme[];
  activeDestination: Destination | undefined;
  availableDestinations: Destination[];
  activeConfiguration: string | undefined;
  availableConfigurations: string[];
}

export function createState(): XcodeState {
  return {
    activeProject: undefined,
    activeScheme: undefined,
    availableSchemes: [],
    activeDestination: undefined,
    availableDestinations: [],
    activeConfiguration: undefined,
    availableConfigurations: [],
  };
}
