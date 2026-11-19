import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

// Start daemon detached so restarting core/dev keeps live PTYs and Claude CLI sessions alive
const daemon = spawn(pnpmCmd, ['--filter', '@myagents/daemon', 'run', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

setTimeout(() => {
  const core = spawn(pnpmCmd, ['--filter', '@myagents/core', 'run', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  const web = spawn(pnpmCmd, ['--filter', '@myagents/web', 'run', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  const shutdown = () => {
    core.kill()
    web.kill()
    daemon.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}, 1200)
