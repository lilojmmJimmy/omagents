import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const isWin = process.platform === 'win32'
const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-smoke-'))
const port = 3219
const daemonEndpoint = isWin
  ? `\\\\.\\pipe\\myagents-smoke-${process.pid}-${Date.now()}`
  : path.join(tmpHome, 'run', 'daemon.sock')

const proc = spawn(process.execPath, ['scripts/start.mjs'], {
  env: {
    ...process.env,
    MYAGENTS_PORT: String(port),
    MYAGENTS_HOME: tmpHome,
    MYAGENTS_DAEMON_ENDPOINT: daemonEndpoint
  },
  // Create a dedicated process group on POSIX so cleanup terminates pnpm/tsx/core/esbuild descendants
  detached: !isWin,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})

let logs = ''
proc.stdout.on('data', (d) => (logs += String(d)))
proc.stderr.on('data', (d) => (logs += String(d)))

function isAlive(targetPid) {
  try {
    process.kill(targetPid, 0)
    return true
  } catch (err) {
    return err?.code !== 'ESRCH'
  }
}

async function waitForExit(targetPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(targetPid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isAlive(targetPid)
}

async function queryDaemonPid(endpoint, timeoutMs = 1_500) {
  return await new Promise((resolve) => {
    let settled = false
    let buffer = ''
    const sock = net.createConnection(endpoint)
    const finish = (pid) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(pid)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    sock.once('error', () => finish(null))
    sock.once('connect', () => {
      sock.write(`${JSON.stringify({ id: 'smoke-info', method: 'info', params: {} })}\n`)
    })
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      try {
        const msg = JSON.parse(buffer.slice(0, nl))
        const pid = msg?.result?.pid
        finish(typeof pid === 'number' && pid > 0 ? pid : null)
      } catch {
        finish(null)
      }
    })
    sock.once('close', () => finish(null))
  })
}

async function stopProcessTree(pid, { isGroup = false, graceMs = 3_000 } = {}) {
  if (!pid || pid === process.pid) return
  if (isWin) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('close', () => resolve())
      killer.once('error', () => resolve())
    })
    return
  }
  const target = isGroup ? -pid : pid
  try {
    process.kill(target, 'SIGTERM')
  } catch {
    return
  }
  if (await waitForExit(target, graceMs)) return
  try {
    process.kill(target, 'SIGKILL')
  } catch {
    return
  }
  await waitForExit(target, 1_000)
}

async function waitForHealth(deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return await res.json()
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Health check timed out. Logs:\n${logs}`)
}

try {
  const health = await waitForHealth(12_000)
  const webRes = await fetch(`http://127.0.0.1:${port}/`)
  const html = await webRes.text()
  console.log('HEALTH:', JSON.stringify(health))
  console.log('WEB_STATUS:', webRes.status, 'HAS_TITLE:', html.includes('MyAgents'))
  if (!health.ok || webRes.status !== 200 || !html.includes('MyAgents')) {
    process.exitCode = 1
  }
} finally {
  const daemonPid = await queryDaemonPid(daemonEndpoint)
  await stopProcessTree(proc.pid, { isGroup: true, graceMs: 3_000 })
  proc.stdout?.destroy()
  proc.stderr?.destroy()
  await stopProcessTree(daemonPid, { isGroup: false, graceMs: 2_000 })
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore Windows file lock
  }
}
