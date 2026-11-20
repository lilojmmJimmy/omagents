# Third-Party Notices

This project includes or adapts code and design patterns from the following third-party open-source projects:

## Antumi
- **Source**: https://github.com/flyhero/antumi
- **License**: Apache License 2.0
- **Adapted Files & Components**:
  - `packages/daemon/src/session-host.ts` (detached daemon session lifecycle)
  - `packages/daemon/src/pty-session.ts` (PTY session wrapper)
  - `packages/daemon/src/pipe-session.ts` (headless pipe session wrapper with stdin/EOF support)
  - `packages/daemon/src/output-buffer.ts` (ring output buffer and reconnect replay)
  - `packages/protocol/src/node/daemon-protocol.ts` (daemon NDJSON framing and RPC contract)
  - `packages/protocol/src/node/command-launch.ts` (cross-platform command launch planning)
  - Architectural concepts adapted for 5-layer agent isolation, restart-resilient stdio MCP bridging, and delivery batching.

## Orca
- **License**: MIT License
- **Adapted Files & Components**:
  - `packages/protocol/src/node/command-launch.ts` (Windows `.cmd`/`.ps1` shim resolution utilities adapted from Orca and Antumi).
