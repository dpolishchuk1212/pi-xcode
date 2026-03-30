/**
 * Persist and restore user selections (project, scheme, destination, configuration)
 * across sessions. Stored in `.pi/xcode-state.json` relative to the working directory.
 */

import fs from "node:fs/promises";
import nodePath from "node:path";
import { createLogger } from "./log.js";

const debug = createLogger("persist");

const STATE_FILE = ".pi/xcode-state.json";

export interface PersistedState {
  projectPath?: string;
  schemeName?: string;
  destinationId?: string;
  configuration?: string;
}

function stateFilePath(cwd: string): string {
  return nodePath.join(cwd, STATE_FILE);
}

export async function loadPersistedState(cwd: string): Promise<PersistedState> {
  try {
    const raw = await fs.readFile(stateFilePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    debug("loaded persisted state:", JSON.stringify(parsed));
    return parsed;
  } catch {
    debug("no persisted state found (or invalid)");
    return {};
  }
}

export async function savePersistedState(cwd: string, state: PersistedState): Promise<void> {
  const filePath = stateFilePath(cwd);
  try {
    await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    debug("saved persisted state:", JSON.stringify(state));
  } catch (e) {
    debug("failed to save persisted state:", e);
  }
}

/**
 * Build a PersistedState snapshot from the current runtime state.
 */
export function snapshotState(state: {
  activeProject?: { path: string } | undefined;
  activeScheme?: { name: string } | undefined;
  activeDestination?: { id: string } | undefined;
  activeConfiguration?: string | undefined;
}): PersistedState {
  return {
    projectPath: state.activeProject?.path,
    schemeName: state.activeScheme?.name,
    destinationId: state.activeDestination?.id,
    configuration: state.activeConfiguration,
  };
}
