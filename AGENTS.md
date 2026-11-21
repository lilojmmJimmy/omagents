# AGENTS.md

MyAgents is a server-side multi-agent orchestration middleware and React web workspace platform built with TypeScript, Node.js 22+ `node:sqlite`, Fastify, and a detached process-hosting daemon.

## 1. Project Environment

- **Tech Stack**: TypeScript 5.8 (ESM, `"type": "module"`), pnpm workspace monorepo, Node.js >= 22.13 (`node:sqlite` for zero-C++ persistence in `core`), Fastify + `ws`, Zod, `node-pty` (only in `daemon`), React 19 + Vite 6 + Tailwind CSS v4 + Zustand (`web`), Vitest (`test`).
- **Entry Points**: `packages/core/src/main.ts` (HTTP/WS server and collaboration engine), `packages/daemon/src/main.ts` (detached PTY/pipe session host), `packages/web/src/main.tsx` (React SPA), `scripts/start.mjs` (production single-port runner), `scripts/dev.mjs` (dev hot-reload runner).
- **Target Platforms**: Windows (`win32`, Named Pipes, `.cmd`/`.ps1` shim resolution) and POSIX (Linux / macOS, Unix domain sockets, process groups).
- **Required Tools**: Node.js >= 22.13, `pnpm`, `git`; optional external CLIs (`claude`, `codex`, `gemini`).
- **Shared Compiler Settings (`tsconfig.base.json`)**: `target: ES2023`, `module: ESNext`, `moduleResolution: Bundler`, `strict: true`, `noUncheckedIndexedAccess: true`, `isolatedModules: true`, `verbatimModuleSyntax: true`, `noEmit: true`.

When adding a new workspace package:
- Place it under `packages/` (auto-included by `pnpm-workspace.yaml`).
- Extend `../../tsconfig.base.json` in `tsconfig.json` without duplicating shared compiler options.
- Set `"type": "module"`, expose TypeScript entry points via `exports`, and provide `"typecheck": "tsc -p ."`.

## 2. Directory Structure

| Path | Responsibility |
| --- | --- |
| `packages/core` | Core server (`src/main.ts`), collaboration engine, agent drivers, workspace/git services, inbox/webhooks, SQLite storage, HTTP/WS RPC transport, and security hooks. |
| `packages/daemon` | Detached process host (`src/main.ts`) managing PTY (`node-pty`) and pipe child sessions so `core` restarts preserve live sessions. |
| `packages/protocol` | Shared Zod schemas and TypeScript contracts (`@myagents/protocol` browser-safe; `@myagents/protocol/node` Node-only daemon protocol, paths, private-file I/O, and cross-platform command launcher). |
| `packages/plugin-sdk` | Public interfaces and helpers for inbox `SourcePlugin` extensions. |
| `packages/web` | React 19 + Vite + Tailwind CSS v4 single-page web workbench (compiled to `packages/web/dist` and served by `core` in production). |
| `scripts/` | Dev/start launchers and end-to-end smoke/live verification scripts. |
| `docs/` | Architecture specifications, domain/API/DB design documents, roadmap, and milestone test reports. |

Layering rules:
- Keep domain-specific logic inside its owning package/module; move only genuinely shared schemas, pure helpers, or cross-platform IPC/launch utilities into `packages/protocol`.
- Never import Node built-ins or `@myagents/protocol/node` into `packages/web` or browser-safe `@myagents/protocol` modules.
- Reuse existing shared utilities (`planLaunch`, `createNdjsonParser`, `resolveContainedPath`, `writePrivateFileSync`, `CoreDatabase`) instead of duplicating process spawning, framing, or filesystem I/O.

### 2.1 Module Guidelines

- `packages/core/src/collab/`: Keep strategy implementations (`single`, `open-channel`, `roundtable`) pure and deterministic; execute DB and state mutations in `CollabEngine`.
- `packages/core/src/runtime/`: Register `daemon.onEvent` listeners before invoking `spawnPipe`/`spawnPipeClean`; pass `closeStdin: true` (or `stdinData` + `closeStdin: true`) for one-shot CLIs and keep stdin open only for interactive streaming CLIs (`ClaudeCodeDriver`); enforce 5-layer isolation via `AgentEnvironmentIsolator`.
- `packages/core/src/workspace/`: Guard all filesystem paths through `path-guard.ts` and serialize git worktree mutations through `RepoMutex`.
- `packages/core/src/storage/`: Maintain forward-only SQLite migrations in `CoreDatabase` using native `node:sqlite`; do not introduce native C++ SQLite dependencies.
- `packages/daemon/src/`: Keep the daemon thin and free of business logic; bump `DAEMON_PROTOCOL_VERSION` whenever daemon RPC schemas change.
- `packages/web/src/`: Centralize client state in `store/app-store.ts` and RPC calls in `api/rpc-client.ts`; rebuild `packages/web/dist` via `pnpm run build` whenever web code changes so `pnpm start` serves the latest bundle.

## 3. Code Standards

- **English Only (Mandatory)**: The project must strictly use English everywhere—code, identifiers, comments, UI copy, error messages, logs, tests, commit messages, and documentation. Never use any other language.
- **Concise Comments**: Do not write comments for simple or self-explanatory code. Explain complex or non-obvious logic in one concise sentence.
- **TypeScript Best Practices**: Adhere strictly to `strict: true`, `noUncheckedIndexedAccess: true`, and `verbatimModuleSyntax: true` (use `import type` for type-only imports). Validate external boundaries (HTTP, RPC, WebSocket, Daemon NDJSON, Webhooks) with Zod schemas and avoid `any`.
- **Formatting & Conventions**: Use Biome (`biome.json`) and `.editorconfig` enforcing 2-space indentation, LF line endings, single quotes (double JSX quotes), no semicolons, no trailing commas, ES modules, and structured errors via `Errors.*` in `core`.
- **Cross-Platform Safety**: Handle Windows and POSIX differences cleanly; launch external CLIs through `planLaunch` instead of `shell: true`.

## 4. Security & Isolation

- Never weaken `AgentEnvironmentIsolator`, `path-guard.ts`, webhook signature checks, or untrusted-source lockdown defaults.
- Never log or expose secrets, tokens, or API keys; write private local metadata files with `writePrivateFileSync` (`0600`).
- Isolate test runs with temporary directories, `:memory:` databases when possible, and unique `MYAGENTS_DAEMON_ENDPOINT` values so running local services are never disturbed.

## 5. Testing

- Co-locate unit and integration tests next to source files as `packages/**/src/**/*.test.ts` (matched by `vitest.config.ts`).
- Always clean up spawned child processes (such as test daemons) and temporary directories in `afterAll`.
- Do not write duplicate tests, tests that only exercise third-party libraries, unreachable-code tests, or ineffective boilerplate tests.

## 6. Verification

Run from the repository root (`biome.json` provides linting, formatting, and import organization alongside TypeScript `tsc -p .` and Vite build):

```bash
pnpm run check
pnpm run check:fix
pnpm run lint
pnpm run format
pnpm run typecheck
pnpm run build
pnpm vitest run <path/to/file.test.ts>
pnpm test
```

When verifying end-to-end runtime behavior, run `node scripts/smoke.mjs` or `node --import tsx scripts/verify-claude-v01b-live.mjs --mock-anthropic` as needed.

## 7. Documentation & Delivery

- Keep `README.md`, `docs/` specifications/roadmaps, and third-party license/attribution notices (for example, Antumi Apache-2.0 and Orca MIT adaptations) up to date when architecture, protocols, or adapted code changes. All new documentation must follow the English-only rule.
- Commit changes in clean, focused batches using Conventional Commits: `<type>(<scope>): <summary>` (for example, `feat(collab): ...`, `fix(daemon): ...`, `test(runtime): ...`, `docs: ...`). Never push to a remote unless explicitly asked.
