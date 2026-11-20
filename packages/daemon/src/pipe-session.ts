// Adapted from Antumi pipe-session (Apache License 2.0).
import { spawn } from 'node:child_process'
import os from 'node:os'
import { cleanEnv, planLaunch, type DaemonParsedParams } from '@myagents/protocol/node'
import type { HostedProcess, ProcessEvents } from './session-host'

const ignore = () => {}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal ? 128 + (os.constants.signals[signal] ?? 0) : -1
}

export function startPipe(
  { command, args, cwd, env, stdinData, closeStdin }: DaemonParsedParams<'spawnPipe'>,
  events: ProcessEvents,
  clean = false
): HostedProcess {
  const baseEnv = clean ? cleanEnv(process.env) : process.env
  const launch = planLaunch(command, args, cwd, { ...baseEnv, ...env })
  const group = process.platform !== 'win32'
  const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] =
    closeStdin && stdinData === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']
  const child = spawn(launch.file, launch.args, {
    cwd,
    env: launch.env,
    stdio,
    detached: group,
    windowsHide: true
  })

  let exited = false
  const finish = (exitCode: number) => {
    if (!exited) {
      exited = true
      events.exit(exitCode)
    }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', events.output)
  child.stderr?.on('data', events.errorOutput)
  child.stdin?.on('error', ignore)
  child.stdout?.on('error', ignore)
  child.stderr?.on('error', ignore)
  child.on('error', () => {
    if (child.pid === undefined) finish(-1)
  })
  child.on('close', (code, signal) => finish(code ?? signalExitCode(signal)))

  if (child.stdin) {
    if (stdinData !== undefined) {
      if (closeStdin) child.stdin.end(stdinData)
      else if (stdinData.length > 0) child.stdin.write(stdinData)
    } else if (closeStdin) {
      child.stdin.end()
    }
  }

  return {
    get pid() {
      return child.exitCode === null && child.signalCode === null ? child.pid : undefined
    },
    write(data) {
      if (!exited && child.stdin?.writable) child.stdin.write(data)
    },
    endInput() {
      if (!exited && child.stdin?.writable) child.stdin.end()
    },
    resize() {},
    kill(force) {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', ignore)
        return
      }
      try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        // Already exited
      }
    }
  }
}
