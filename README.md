# pi-xcode

A [pi](https://github.com/nichochar/pi-coding-agent) extension for managing Xcode projects from your coding agent sessions.

## Features

- Auto-discovers projects, schemes, and simulators on session start
- Smart defaults — picks the best scheme and latest iPhone simulator
- Real-time build/test progress in the status bar
- Supports iOS simulators, physical devices, and Mac destinations
- Fuzzy search in all selection dialogs

## Install

```bash
pi install /path/to/pi-xcode
```

## Tools

Used by the AI agent. All parameters are optional — defaults come from session state.

| Tool | Description |
|------|-------------|
| `xcode_build` | Build the active project. Returns parsed errors/warnings. Optional: `configuration`, `destination`, `simulator`. |
| `xcode_run` | Build, install, and launch the app on the active destination. Optional: `configuration`, `simulator`, `skipBuild`. |
| `xcode_test` | Run unit/UI tests with structured pass/fail results. Optional: `configuration`, `destination`, `simulator`, `testPlan`, `onlyTesting`, `skipTesting`. |
| `xcode_clean` | Clean build artifacts. No parameters. |
| `xcode_stop` | Stop the active build, test, or run operation. No parameters. |

## Commands

Invoked by the user via `/` in the pi TUI.

| Command | Description |
|---------|-------------|
| `/project` | Select the active project or workspace |
| `/scheme` | Select the build scheme |
| `/destination` | Select simulator, device, or Mac |
| `/configuration` | Select Debug, Release, or custom configuration |
| `/build` | Build the active project |
| `/run [scheme]` | Build and run the app |
| `/test [filter] [--plan name]` | Run tests with optional filter or test plan |
| `/clean` | Clean build artifacts |
| `/stop` | Stop the current operation |

## Development

```bash
npm install
npm test
npm run check   # typecheck + lint + dead code
```

## License

MIT
