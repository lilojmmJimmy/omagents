import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const core = spawn(pnpmCmd, ['--filter', '@myagents/core', 'run', 'start'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env }
})

core.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => core.kill('SIGINT'))
process.on('SIGTERM', () => core.kill('SIGTERM'))
