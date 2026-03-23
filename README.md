# pi-xcode

A [pi](https://github.com/nichochar/pi-coding-agent) extension that brings full Xcode project management directly into your coding agent sessions. Build, run, test, and manage Xcode projects without leaving the terminal.

## Features

- **Auto-discovery** — Automatically finds `.xcworkspace`, `.xcodeproj`, and `Package.swift` files on session start
- **Smart defaults** — Auto-selects the best scheme (prefers app targets matching the project name) and destination (latest iPhone simulator)
- **Real-time progress** — Status bar with animated spinner, elapsed time, build task count, and test pass/fail counts
- **Multi-destination support** — Run on iOS simulators, physical devices (via `devicectl`), or Mac (including Mac Catalyst)
- **App lifecycle tracking** — Monitors running apps and updates status when they exit
- **Fuzzy search** — All selection dialogs support type-to-filter for quick navigation
- **Replaces built-in tools** — Overrides pi's default Xcode tools with enhanced versions that use session state

## Install

```bash
pi install /path/to/pi-xcode
```

Or for local development:

```bash
pi -e ./src/index.ts
```

## Tools

Tools are used by the AI agent during conversations. They auto-discover project settings when parameters are omitted, falling back to the active session state.

| Tool | Description |
|------|-------------|
| **xcode_build** | Build an Xcode project or workspace. Returns parsed errors and warnings with `file:line:column` locations. |
| **xcode_run** | Build, install, and launch an app on a simulator, physical device, or Mac. Handles booting simulators, installing, and launching automatically. |
| **xcode_test** | Run unit or UI tests. Returns structured results with pass/fail counts, durations, and failure messages. Supports `onlyTesting`, `skipTesting`, and test plans. |
| **xcode_clean** | Clean build artifacts. Uses `swift package clean` for SPM packages. Stops any active operation first. |
| **xcode_discover** | List all projects, workspaces, schemes, and available simulators in the current directory. |
| **xcode_stop** | Stop the active build, test, or run operation. Kills `xcodebuild` processes and terminates running apps. |

## Commands

Commands are invoked directly by the user via the `/` prefix in the pi TUI.

| Command | Description |
|---------|-------------|
| `/project` | Browse and select the active Xcode project or workspace |
| `/scheme` | Select the active build scheme (shows product type: Application, Framework, Tests, Extension) |
| `/destination` | Select the run destination — simulators, physical devices, or Mac |
| `/configuration` | Select the build configuration (Debug, Release, or custom) |
| `/build` | Build the active project with the current scheme, configuration, and destination |
| `/run [scheme]` | Build and run the app on the active destination |
| `/test [filter] [--plan name]` | Run tests, optionally filtered or with a specific test plan |
| `/clean` | Clean build artifacts for the active project |
| `/stop` | Stop the currently running operation |

## Status Bar

The extension adds a persistent status bar showing the current session state:

```
project.xcodeproj · MyApp · Debug · iPhone 16 26.0 · ⠹ Building 12s [42]
```

During operations, it displays:
- **Building** — Elapsed time and number of completed compilation tasks
- **Testing** — Elapsed time with passed ✓ and failed ✗ counts
- **Running** — Indicator that the app is active (▶)
- **Cleaning** — Elapsed time

## How It Works

### Session Start

When a pi session begins, the extension automatically:

1. Scans for `.xcworkspace`, `.xcodeproj`, and `Package.swift` files (up to 6 levels deep)
2. Selects the best project (prefers workspaces over standalone projects)
3. Discovers schemes and picks the best one (app targets first, matching project name)
4. Discovers build configurations (Debug, Release, etc.)
5. Discovers available destinations and picks the best one (latest iPhone simulator)
6. Updates the status bar with the resolved settings

### Build Streaming

Builds and tests use real-time streaming output parsing. Instead of waiting for `xcodebuild` to finish, the extension:

- Spawns `xcodebuild` directly and reads `stdout`/`stderr` line by line
- Counts completed build tasks (`CompileSwift`, `Ld`, `CodeSign`, etc.)
- Counts test passes and failures as they happen
- Updates the status bar spinner with live progress

### Destination Handling

The extension supports three destination types with platform-specific workflows:

| Type | Boot | Install | Launch | Terminate |
|------|------|---------|--------|-----------|
| **Simulator** | `simctl boot` + open Simulator.app | `simctl install` | `simctl launch` | `simctl terminate` |
| **Physical Device** | No-op | `devicectl device install app` | `devicectl device process launch` | — |
| **Mac** | No-op | No-op (runs from build dir) | `open <app>` | AppleScript quit |

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Watch mode
npm run test:watch

# Lint
npm run lint

# Full check (typecheck + lint + dead code)
npm run check
```

## Project Structure

```
src/
├── index.ts          # Extension entry point — registers commands, tools, and session hooks
├── tools/            # AI-facing tool implementations
│   ├── build.ts      # xcode_build tool
│   ├── run.ts        # xcode_run tool
│   ├── test.ts       # xcode_test tool
│   ├── clean.ts      # xcode_clean tool
│   ├── discover.ts   # xcode_discover tool
│   └── stop.ts       # xcode_stop tool
├── discovery.ts      # Project, scheme, simulator, and destination discovery
├── resolve.ts        # Auto-detection and resolution of project/scheme/destination
├── auto-select.ts    # Heuristics for picking the best scheme and destination
├── runner.ts         # Platform-specific app install, launch, terminate, and monitoring
├── commands.ts       # xcodebuild CLI argument builders
├── parsers.ts        # Output parsers for build results, test results, settings, etc.
├── streaming.ts      # Real-time xcodebuild output streaming with progress counting
├── status-bar.ts     # Status bar rendering and spinner animation
├── state.ts          # Shared mutable session state
├── format.ts         # Human-readable formatting for build/test results
└── types.ts          # TypeScript type definitions
tests/                # Unit tests (vitest)
```

## License

MIT
