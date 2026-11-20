// Adapted from Antumi daemon-protocol (Apache License 2.0).
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

export const DAEMON_PROTOCOL_VERSION = 2

export const CLEAN_ENV_KEYS: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TZ',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'USERNAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
]

export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CLEAN_ENV_KEYS.includes(key.toUpperCase())) kept[key] = value
  }
  return kept
}

export const SessionIo = z.enum(['pty', 'pipe'])
export type SessionIo = z.infer<typeof SessionIo>

const SessionRef = z.object({ sessionId: z.string() })
const Ok = z.object({ ok: z.literal(true) })

export const SessionInfo = z.object({
  sessionId: z.string(),
  io: SessionIo,
  exited: z.boolean(),
  exitCode: z.number().int().nullable(),
  pid: z.number().int().optional()
})
export type SessionInfo = z.infer<typeof SessionInfo>

const LaunchParams = z.object({
  sessionId: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  env: z.record(z.string()).default({})
})

const PipeLaunchParams = LaunchParams.extend({
  stdinData: z.string().optional(),
  closeStdin: z.boolean().optional()
})

export const AttachResultSchema = SessionInfo.extend({
  buffer: z.string(),
  bufferStart: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  stderr: z.string().optional()
})
export type AttachResult = z.infer<typeof AttachResultSchema>

export const daemonMethods = {
  info: {
    params: z.object({}),
    result: z.object({ protocolVersion: z.number().int(), version: z.string(), pid: z.number().int() })
  },
  spawnPty: {
    params: LaunchParams.extend({ cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: SessionRef
  },
  spawnPipe: {
    params: PipeLaunchParams,
    result: SessionRef
  },
  spawnPipeClean: {
    params: PipeLaunchParams,
    result: SessionRef
  },
  write: {
    params: SessionRef.extend({ data: z.string() }),
    result: Ok
  },
  endInput: {
    params: SessionRef,
    result: Ok
  },
  resize: {
    params: SessionRef.extend({ cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: Ok
  },
  kill: {
    params: SessionRef.extend({ force: z.boolean().optional() }),
    result: Ok
  },
  attach: {
    params: SessionRef,
    result: AttachResultSchema
  },
  list: {
    params: z.object({}),
    result: z.object({ sessions: z.array(SessionInfo) })
  },
  release: {
    params: SessionRef,
    result: Ok
  }
} as const

export type DaemonMethod = keyof typeof daemonMethods
export type DaemonParams<M extends DaemonMethod> = z.input<(typeof daemonMethods)[M]['params']>
export type DaemonParsedParams<M extends DaemonMethod> = z.output<(typeof daemonMethods)[M]['params']>
export type DaemonResult<M extends DaemonMethod> = z.infer<(typeof daemonMethods)[M]['result']>

export const DaemonEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('data'), sessionId: z.string(), data: z.string(), offset: z.number().int().nonnegative() }),
  z.object({ event: z.literal('stderr'), sessionId: z.string(), data: z.string() }),
  z.object({ event: z.literal('exit'), sessionId: z.string(), exitCode: z.number().int() })
])
export type DaemonEvent = z.infer<typeof DaemonEventSchema>

export interface DaemonRequestFrame {
  id: string
  method: DaemonMethod
  params: unknown
}

export interface DaemonResponseFrame {
  id: string
  result?: unknown
  error?: string
}

export function createNdjsonParser(onMessage: (msg: unknown) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let nl = pending.indexOf('\n')
    while (nl !== -1) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (line) {
        try {
          onMessage(JSON.parse(line))
        } catch {
          // Ignore malformed frame
        }
      }
      nl = pending.indexOf('\n')
    }
  }
}
