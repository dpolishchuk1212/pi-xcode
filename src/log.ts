/**
 * Shared debug logging for pi-xcode extension.
 * Enable with PI_XCODE_DEBUG=1 environment variable.
 */

const DEBUG = process.env.PI_XCODE_DEBUG === "1";

/**
 * Create a scoped debug logger.
 * Usage: `const log = createLogger("run");` → prints `[pi-xcode:run] ...`
 */
export function createLogger(module: string) {
  const prefix = `[pi-xcode:${module}]`;
  return (...args: unknown[]) => {
    if (DEBUG) console.log(prefix, ...args);
  };
}
