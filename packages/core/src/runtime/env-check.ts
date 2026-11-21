import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { planLaunch, resolveCommand } from '@myagents/protocol/node'

const execFileAsync = promisify(execFile)

export interface CliCheckResult {
  kind: string
  installed: boolean
  path: string | null
  version: string | null
  ready: boolean
  problem?: string
}

async function probeCommand(
  command: string,
  args: string[]
): Promise<{ installed: boolean; path: string | null; version: string | null; problem?: string }> {
  const resolved = resolveCommand(command, process.cwd(), process.env)
  if (!resolved) return { installed: false, path: null, version: null, problem: 'not-installed' }
  try {
    const launch = planLaunch(command, args, process.cwd(), process.env)
    const { stdout, stderr } = await execFileAsync(launch.file, launch.args, {
      env: launch.env,
      timeout: 8000,
      windowsHide: true
    })
    const line =
      (stdout || stderr)
        .split(/\r?\n/)
        .find((l) => l.trim())
        ?.trim() || null
    return { installed: true, path: resolved, version: line }
  } catch (err) {
    return {
      installed: true,
      path: resolved,
      version: null,
      problem: err instanceof Error ? err.message : String(err)
    }
  }
}

export class EnvCheckService {
  private cached: { checkedAt: number; git: CliCheckResult; clis: CliCheckResult[] } | null = null

  async check(refresh = false): Promise<{ checkedAt: number; git: CliCheckResult; clis: CliCheckResult[] }> {
    if (!refresh && this.cached && Date.now() - this.cached.checkedAt < 60_000) {
      return this.cached
    }
    const [gitRes, claudeRes, codexRes, geminiRes] = await Promise.all([
      probeCommand('git', ['--version']),
      probeCommand('claude', ['--version']),
      probeCommand('codex', ['--version']),
      probeCommand('gemini', ['--version'])
    ])
    const result = {
      checkedAt: Date.now(),
      git: {
        kind: 'git',
        ...gitRes,
        ready: gitRes.installed && !gitRes.problem
      },
      clis: [
        {
          kind: 'claude',
          ...claudeRes,
          ready: claudeRes.installed && !claudeRes.problem
        },
        {
          kind: 'codex',
          ...codexRes,
          ready: codexRes.installed && !codexRes.problem
        },
        {
          kind: 'gemini',
          ...geminiRes,
          ready: geminiRes.installed && !geminiRes.problem
        }
      ]
    }
    this.cached = result
    return result
  }
}
