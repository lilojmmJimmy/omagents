import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-smoke-'))
const port = 3219
const proc = spawn(process.execPath, ['scripts/start.mjs'], {
  env: { ...process.env, MYAGENTS_PORT: String(port), MYAGENTS_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe']
})

let logs = ''
proc.stdout.on('data', (d) => (logs += String(d)))
proc.stderr.on('data', (d) => (logs += String(d)))

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
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
  } else {
    proc.kill('SIGTERM')
  }
  await new Promise((r) => setTimeout(r, 600))
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore Windows file lock
  }
}
