import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent, Workspace } from '@myagents/protocol'
import { AgentEnvironmentIsolator } from './environment-isolator'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-iso-1',
    name: 'IsoAgent',
    bio: '',
    avatar: {},
    systemPrompt: 'Stay concise.',
    driverKind: 'claude',
    providerId: null,
    driverConfig: { model: 'sonnet' },
    defaultWorkspaceId: 'ws-1',
    permissionMode: 'workspace-write',
    isolationMode: 'standard',
    skillIds: [],
    mcpServerIds: [],
    maxRunningTurns: 2,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeWorkspace(rootPath: string): Workspace {
  return {
    id: 'ws-1',
    kind: 'project',
    name: 'Proj',
    rootPath,
    isGit: true,
    gitCommonDir: path.join(rootPath, '.git'),
    gitBranch: 'main',
    baseCommit: 'abc',
    parentWorkspaceId: null,
    ownerType: 'global',
    ownerId: null,
    readonlyRefs: [],
    cleanedAt: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('AgentEnvironmentIsolator (5-Layer Isolation)', () => {
  const prevHome = process.env.MYAGENTS_HOME
  let tmpHome: string | null = null

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MYAGENTS_HOME
    else process.env.MYAGENTS_HOME = prevHome
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true })
      tmpHome = null
    }
  })

  it('enforces dual-layer subagent block without forcing cleanEnv in standard mode', async () => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-iso-'))
    process.env.MYAGENTS_HOME = tmpHome
    const isolator = new AgentEnvironmentIsolator()
    const ws = makeWorkspace(path.join(tmpHome, 'proj'))

    const single = await isolator.buildLaunchPlan({
      agent: makeAgent({ isolationMode: 'standard' }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: false,
      readableFiles: [],
      readonlyRefPaths: []
    })
    expect(single.profile.level).toBe('standard')
    expect(single.profile.cleanEnv).toBe(false)
    expect(single.profile.blockSubagents).toBe(false)
    expect(single.profile.disallowedTools).not.toContain('Agent')

    const multi = await isolator.buildLaunchPlan({
      agent: makeAgent({ isolationMode: 'standard' }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: true,
      readableFiles: [],
      readonlyRefPaths: [],
      mcpConfigPath: path.join(tmpHome, 'run', 'mcp-1.json')
    })
    expect(multi.profile.blockSubagents).toBe(true)
    expect(multi.profile.disallowedTools).toContain('Agent')
    expect(multi.profile.disallowedTools).toContain('Task')
    expect(multi.profile.allowedTools).toContain('mcp__myagents__collab_dispatch')
  })

  it('isolates CLAUDE_CONFIG_DIR in isolated-home and only sets host provider overrides when providerId is set', async () => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-iso-home-'))
    process.env.MYAGENTS_HOME = tmpHome
    const isolator = new AgentEnvironmentIsolator()
    const ws = makeWorkspace(path.join(tmpHome, 'proj'))

    const selfAuthPlan = await isolator.buildLaunchPlan({
      agent: makeAgent({ id: 'a-home-1', isolationMode: 'isolated-home', providerId: null }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: false,
      readableFiles: [],
      readonlyRefPaths: []
    })

    const expectedHome = path.join(tmpHome, 'agent-homes', 'agent-a-home-1')
    expect(selfAuthPlan.profile.cleanEnv).toBe(true)
    expect(selfAuthPlan.profile.configHomeDir).toBe(expectedHome)
    expect(existsSync(path.join(expectedHome, 'projects'))).toBe(true)
    expect(selfAuthPlan.profile.envOverrides?.CLAUDE_CONFIG_DIR).toBe(expectedHome)
    expect(selfAuthPlan.profile.envOverrides?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined()

    const customProviderPlan = await isolator.buildLaunchPlan({
      agent: makeAgent({ id: 'a-home-1', isolationMode: 'isolated-home', providerId: 'prov-custom-1' }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: false,
      readableFiles: [],
      readonlyRefPaths: []
    })
    expect(customProviderPlan.profile.envOverrides).toMatchObject({
      CLAUDE_CONFIG_DIR: expectedHome,
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_MODEL: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1'
    })
  })

  it('compiles lockdown + fenced-ro rules + readonly ref dirs & readable attachments without modifying host home', async () => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-iso-lock-'))
    process.env.MYAGENTS_HOME = tmpHome
    const isolator = new AgentEnvironmentIsolator()
    const wsRoot = path.join(tmpHome, 'proj')
    const refDir = path.join(tmpHome, 'knowledge')
    const attachFile = path.join(tmpHome, 'attachments', 'spec.md')
    const ws = makeWorkspace(wsRoot)

    const fenced = await isolator.buildLaunchPlan({
      agent: makeAgent({ isolationMode: 'standard', permissionMode: 'workspace-write' }),
      workspace: ws,
      workspaceMode: 'read-only',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: true,
      readableFiles: [attachFile],
      readonlyRefPaths: [refDir]
    })
    expect(fenced.profile.level).toBe('fenced-ro')
    expect(fenced.profile.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'MultiEdit', 'Agent', 'Task']))
    expect(fenced.profile.allowedTools.some((r) => r.startsWith('Read(') && r.includes('/knowledge/**'))).toBe(true)
    expect(fenced.profile.allowedTools.some((r) => r.startsWith('Read(') && r.endsWith('spec.md)'))).toBe(true)
    expect(fenced.profile.disallowedTools.some((r) => r.startsWith('Edit(') && r.includes('/knowledge/**'))).toBe(true)

    const lockdown = await isolator.buildLaunchPlan({
      agent: makeAgent({ id: 'a-lock', isolationMode: 'lockdown' }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'untrusted',
      isMultiAgentRoom: true,
      readableFiles: [],
      readonlyRefPaths: []
    })
    expect(lockdown.profile.level).toBe('lockdown')
    expect(lockdown.profile.cleanEnv).toBe(true)
    expect(lockdown.profile.disallowedTools).toContain('Bash')
    expect(lockdown.profile.allowedTools).toEqual([
      'mcp__myagents__collab_history',
      'mcp__myagents__collab_publish'
    ])
  })

  it('changes configHash when prompt, model, or mcp config drifts', async () => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-iso-hash-'))
    process.env.MYAGENTS_HOME = tmpHome
    const isolator = new AgentEnvironmentIsolator()
    const ws = makeWorkspace(path.join(tmpHome, 'proj'))

    const h1 = await isolator.buildLaunchPlan({
      agent: makeAgent({ systemPrompt: 'v1' }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: false,
      readableFiles: [],
      readonlyRefPaths: [],
      mcpConfigHash: 'm1'
    })
    const h2 = await isolator.buildLaunchPlan({
      agent: makeAgent({ systemPrompt: 'v2' }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: false,
      readableFiles: [],
      readonlyRefPaths: [],
      mcpConfigHash: 'm1'
    })
    const h3 = await isolator.buildLaunchPlan({
      agent: makeAgent({ systemPrompt: 'v1' }),
      workspace: ws,
      workspaceMode: 'shared-rw',
      strategyPolicy: 'shared-rw',
      sourceTrustLevel: 'trusted',
      isMultiAgentRoom: false,
      readableFiles: [],
      readonlyRefPaths: [],
      mcpConfigHash: 'm2'
    })

    expect(h1.configHash).not.toBe(h2.configHash)
    expect(h1.configHash).not.toBe(h3.configHash)
  })
})
