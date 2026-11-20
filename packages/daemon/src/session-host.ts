// Adapted from Antumi session-host (Apache License 2.0).
import { randomUUID } from 'node:crypto'
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonEvent,
  type DaemonMethod,
  type DaemonParsedParams,
  type DaemonResult,
  type SessionInfo,
  type SessionIo
} from '@myagents/protocol/node'
import { OutputBuffer } from './output-buffer'
import { startPipe } from './pipe-session'
import { startPty } from './pty-session'

const PTY_SCROLLBACK_CHARS = 512 * 1024
const PIPE_OUTPUT_CHARS = 8 * 1024 * 1024
const PIPE_STDERR_CHARS = 64 * 1024

export type HostedProcess = {
  pid?: number
  write(data: string): void
  endInput?(): void
  resize(cols: number, rows: number): void
  kill(force: boolean): void
}

export type ProcessEvents = {
  output(data: string): void
  errorOutput(data: string): void
  exit(exitCode: number): void
}

type Session = {
  id: string
  io: SessionIo
  process: HostedProcess
  output: OutputBuffer
  stderr: OutputBuffer | null
  exitCode: number | null
}

export type DaemonHandlers = {
  [M in DaemonMethod]: (params: DaemonParsedParams<M>) => DaemonResult<M>
}

const NOT_STARTED: HostedProcess = { write() {}, resize() {}, kill() {} }

export function createSessionHost(emit: (event: DaemonEvent) => void): {
  handlers: DaemonHandlers
  killAll(): void
} {
  const sessions = new Map<string, Session>()

  function getSession(sessionId: string): Session {
    const session = sessions.get(sessionId)
    if (!session) throw new Error('session-not-found')
    return session
  }

  function toInfo(session: Session): SessionInfo {
    return {
      sessionId: session.id,
      io: session.io,
      exited: session.exitCode !== null,
      exitCode: session.exitCode,
      ...(session.process.pid !== undefined ? { pid: session.process.pid } : {})
    }
  }

  function track(
    io: SessionIo,
    requestedId: string | undefined,
    start: (events: ProcessEvents) => HostedProcess
  ): { sessionId: string } {
    const sessionId = requestedId || randomUUID()
    if (sessions.has(sessionId)) throw new Error('session-already-exists')

    const output = new OutputBuffer(io === 'pty' ? PTY_SCROLLBACK_CHARS : PIPE_OUTPUT_CHARS)
    const stderr = io === 'pipe' ? new OutputBuffer(PIPE_STDERR_CHARS) : null
    const session: Session = { id: sessionId, io, process: NOT_STARTED, output, stderr, exitCode: null }
    sessions.set(sessionId, session)

    try {
      session.process = start({
        output: (data) => {
          const offset = output.append(data)
          emit({ event: 'data', sessionId, data, offset })
        },
        errorOutput: (data) => {
          stderr?.append(data)
          emit({ event: 'stderr', sessionId, data })
        },
        exit: (exitCode) => {
          session.exitCode = exitCode
          emit({ event: 'exit', sessionId, exitCode })
        }
      })
    } catch (error) {
      sessions.delete(sessionId)
      throw error
    }

    return { sessionId }
  }

  const handlers: DaemonHandlers = {
    info: () => ({ protocolVersion: DAEMON_PROTOCOL_VERSION, version: '0.1.0', pid: process.pid }),
    spawnPty: (params) => track('pty', params.sessionId, (events) => startPty(params, params.cols, params.rows, events)),
    spawnPipe: (params) => track('pipe', params.sessionId, (events) => startPipe(params, events, false)),
    spawnPipeClean: (params) => track('pipe', params.sessionId, (events) => startPipe(params, events, true)),
    write: ({ sessionId, data }) => {
      getSession(sessionId).process.write(data)
      return { ok: true }
    },
    endInput: ({ sessionId }) => {
      getSession(sessionId).process.endInput?.()
      return { ok: true }
    },
    resize: ({ sessionId, cols, rows }) => {
      getSession(sessionId).process.resize(cols, rows)
      return { ok: true }
    },
    kill: ({ sessionId, force }) => {
      const s = getSession(sessionId)
      if (s.exitCode === null) s.process.kill(Boolean(force))
      return { ok: true }
    },
    attach: ({ sessionId }) => {
      const s = getSession(sessionId)
      const snap = s.output.snapshot()
      const errSnap = s.stderr?.snapshot()
      return {
        ...toInfo(s),
        ...snap,
        ...(errSnap?.buffer ? { stderr: errSnap.buffer } : {})
      }
    },
    list: () => ({
      sessions: [...sessions.values()].map(toInfo)
    }),
    release: ({ sessionId }) => {
      const s = sessions.get(sessionId)
      if (s && s.exitCode === null) s.process.kill(true)
      sessions.delete(sessionId)
      return { ok: true }
    }
  }

  return {
    handlers,
    killAll() {
      for (const s of sessions.values()) {
        if (s.exitCode === null) s.process.kill(true)
      }
      sessions.clear()
    }
  }
}
