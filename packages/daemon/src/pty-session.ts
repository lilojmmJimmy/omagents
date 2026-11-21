// Adapted from Antumi pty-session (Apache License 2.0).

import { type DaemonParsedParams, planLaunch } from '@myagents/protocol/node'
import * as pty from 'node-pty'
import type { HostedProcess, ProcessEvents } from './session-host'

type PtyLaunch = Omit<DaemonParsedParams<'spawnPty'>, 'cols' | 'rows'>

export function startPty(
  { command, args, cwd, env }: PtyLaunch,
  cols: number,
  rows: number,
  events: ProcessEvents
): HostedProcess {
  const launch = planLaunch(command, args, cwd, { ...process.env, ...env, TERM: 'xterm-256color' })
  const proc = pty.spawn(launch.file, launch.args, {
    name: 'xterm-256color',
    cwd,
    cols,
    rows,
    env: launch.env as Record<string, string>,
    useConptyDll: process.platform === 'win32'
  })
  proc.onData(events.output)
  proc.onExit(({ exitCode }) => events.exit(exitCode))
  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (c, r) => proc.resize(c, r),
    kill: (force) => (force && process.platform !== 'win32' ? proc.kill('SIGKILL') : proc.kill())
  }
}
