import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { EnvironmentIsolator, IsolationProfile } from '@myagents/protocol'
import { myagentsAgentHomePath } from '@myagents/protocol/node'

export function claudeRulePath(file: string): string | null {
  const resolved = path.resolve(file)
  if (resolved.startsWith('/')) return resolved
  const drive = /^([A-Za-z]):[\\/]/.exec(resolved)
  return drive ? `/${drive[1]?.toLowerCase()}/${resolved.slice(3).replaceAll('\\', '/')}` : null
}

function appendReadonlyRule(target: string[], p: string, mode: 'file' | 'dir'): void {
  const rule = claudeRulePath(p)
  if (!rule) return
  const normalized = rule.replace(/\/$/, '')
  if (mode === 'file') {
    target.push(`Read(/${normalized})`)
  } else {
    target.push(`Read(/${normalized}/**)`)
  }
}

function appendNoEditRule(target: string[], dirPath: string): void {
  const rule = claudeRulePath(dirPath)
  if (!rule) return
  const normalized = rule.replace(/\/$/, '')
  target.push(`Edit(/${normalized}/**)`, `Write(/${normalized}/**)`)
}

/**
 * 5-Layer Agent Environment Isolation:
 *  Layer 1: Env Cleaning & Claude provider override zeroing (cleanEnv + envOverrides)
 *  Layer 2: Isolated Home / Config Dir (~/.myagents/agent-homes/agent-<id>, CLAUDE_CONFIG_DIR)
 *  Layer 3: Tool Permission Fence & Dual-Layer Subagent Blocking (lockdown / fenced-ro / Agent,Task)
 *  Layer 4: Workspace, Attachment & Readonly Ref Path Containment (without --add-dir)
 *  Layer 5: Config Drift Detection (16-char SHA-256 configHash)
 */
export class AgentEnvironmentIsolator implements EnvironmentIsolator {
  async buildLaunchPlan(
    ctx: Parameters<EnvironmentIsolator['buildLaunchPlan']>[0]
  ): Promise<{ profile: IsolationProfile; configHash: string }> {
    const readOnly =
      ctx.agent.permissionMode === 'read-only' ||
      ctx.workspaceMode === 'read-only' ||
      ctx.strategyPolicy === 'read-only' ||
      ctx.sourceTrustLevel === 'untrusted'

    const level: IsolationProfile['level'] =
      ctx.agent.isolationMode === 'lockdown' || ctx.sourceTrustLevel === 'untrusted'
        ? 'lockdown'
        : readOnly
          ? 'fenced-ro'
          : 'standard'

    // Layer 1 & 2: Clean environment & isolated config home
    const cleanEnv = ctx.agent.isolationMode !== 'standard' || level === 'lockdown'
    let configHomeDir: string | undefined
    const envOverrides: Record<string, string> = {}

    if (ctx.agent.isolationMode === 'isolated-home' || ctx.agent.isolationMode === 'lockdown') {
      configHomeDir = myagentsAgentHomePath(`agent-${ctx.agent.id}`)
      mkdirSync(configHomeDir, { recursive: true, mode: 0o700 })
      mkdirSync(path.join(configHomeDir, 'projects'), { recursive: true, mode: 0o700 })
    }

    if (ctx.agent.driverKind === 'claude') {
      if (configHomeDir) {
        envOverrides.CLAUDE_CONFIG_DIR = configHomeDir
      }
      if (ctx.agent.providerId) {
        envOverrides.CLAUDE_CODE_USE_BEDROCK = ''
        envOverrides.CLAUDE_CODE_USE_VERTEX = ''
        envOverrides.CLAUDE_CODE_OAUTH_TOKEN = ''
        envOverrides.ANTHROPIC_MODEL = ''
        envOverrides.ANTHROPIC_CUSTOM_HEADERS = ''
        envOverrides.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      }
    }

    // Layer 3 & 4: Tool fence, subagent block & path rules
    const blockSubagents = ctx.isMultiAgentRoom
    const allowedTools: string[] = []
    const disallowedTools: string[] = []

    if (blockSubagents) {
      disallowedTools.push('Agent', 'Task')
    }

    if (level === 'lockdown') {
      disallowedTools.push('Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash')
      allowedTools.push('mcp__myagents__collab_history', 'mcp__myagents__collab_publish')
    } else if (level === 'fenced-ro') {
      allowedTools.push('Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)')
      disallowedTools.push('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
      appendNoEditRule(disallowedTools, ctx.workspace.rootPath)
    }

    if (ctx.mcpConfigPath && level !== 'lockdown') {
      allowedTools.push(
        'mcp__myagents__collab_dispatch',
        'mcp__myagents__collab_reply',
        'mcp__myagents__collab_publish',
        'mcp__myagents__collab_history',
        'mcp__myagents__collab_remember'
      )
      if (level === 'standard' && ctx.externalMcpNames?.length) {
        for (const name of ctx.externalMcpNames) {
          allowedTools.push(`mcp__${name}__*`)
        }
      }
    }

    // Layer 4: Readonly references & exact readable attachments (never via --add-dir)
    for (const refDir of ctx.readonlyRefPaths) {
      appendReadonlyRule(allowedTools, refDir, 'dir')
      appendNoEditRule(disallowedTools, refDir)
    }
    for (const file of ctx.readableFiles) {
      appendReadonlyRule(allowedTools, file, 'file')
    }

    const profile: IsolationProfile = {
      level,
      cleanEnv,
      ...(configHomeDir ? { configHomeDir } : {}),
      ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
      ...(ctx.mcpConfigPath ? { mcpConfigPath: ctx.mcpConfigPath } : {}),
      blockSubagents,
      writableDirs: readOnly ? [] : [ctx.workspace.rootPath],
      readonlyDirs: readOnly ? [ctx.workspace.rootPath, ...ctx.readonlyRefPaths] : [...ctx.readonlyRefPaths],
      readableFiles: [...ctx.readableFiles],
      disallowedTools: [...new Set(disallowedTools)],
      allowedTools: [...new Set(allowedTools)]
    }

    // Layer 5: Drift detection hash
    const configHash = createHash('sha256')
      .update(
        JSON.stringify({
          agentId: ctx.agent.id,
          model: ctx.agent.driverConfig.model ?? null,
          systemPrompt: ctx.agent.systemPrompt,
          permissionMode: ctx.agent.permissionMode,
          isolationMode: ctx.agent.isolationMode,
          workspaceRootPath: ctx.workspace.rootPath,
          mcpConfigHash: ctx.mcpConfigHash ?? null,
          skillsHash: ctx.skillsHash ?? null,
          profile
        })
      )
      .digest('hex')
      .slice(0, 16)

    return { profile, configHash }
  }
}
