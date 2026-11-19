import { describe, expect, it } from 'vitest'
import type { Agent, Workspace } from '@myagents/protocol'
import {
  buildAcpArgs,
  buildCodexArgs,
  parseAcpEventLine,
  parseCodexEventLine
} from './cli-drivers'
import type { TurnInput } from './driver'

function makeTurnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  const agent: Agent = {
    id: 'agent-1',
    name: 'Worker',
    bio: '',
    avatar: {},
    driverKind: 'codex',
    providerId: null,
    systemPrompt: 'Be concise.',
    permissionMode: 'full',
    isolationMode: 'standard',
    defaultWorkspaceId: 'ws-1',
    driverConfig: { model: 'o4-mini' },
    skillIds: [],
    mcpServerIds: [],
    maxRunningTurns: 1,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1
  }
  const workspace: Workspace = {
    id: 'ws-1',
    kind: 'project',
    name: 'Repo',
    rootPath: '/tmp/repo',
    isGit: false,
    gitCommonDir: null,
    gitBranch: null,
    baseCommit: null,
    parentWorkspaceId: null,
    ownerType: 'global',
    ownerId: null,
    readonlyRefs: [],
    cleanedAt: null,
    createdAt: 1,
    updatedAt: 1
  }
  return {
    session: {
      id: 's1',
      roomId: 'r1',
      roomMemberId: 'm1',
      agentId: 'agent-1',
      driverKind: 'codex',
      daemonSessionId: null,
      nativeSessionId: null,
      configHash: null,
      lastDeliveredSeq: 0,
      lastConsumedOffset: 0
    },
    agent,
    roomId: 'r1',
    workNodeId: 'wn1',
    attempt: 1,
    workspace,
    workspaceMode: 'read-only',
    isolation: {
      level: 'fenced-ro',
      cleanEnv: true,
      blockSubagents: true,
      writableDirs: [],
      readonlyDirs: ['/tmp/repo'],
      readableFiles: [],
      disallowedTools: [],
      allowedTools: []
    },
    configHash: 'cfg',
    instruction: 'Analyze module',
    historyMessages: [],
    abortSignal: new AbortController().signal,
    emit: () => {},
    onSessionUpdate: () => {},
    ...overrides
  }
}

describe('CodexCliDriver & AcpCliDriver helpers', () => {
  it('buildCodexArgs sets read-only sandbox & prompt constraint when non-standard or read-only', () => {
    const argsRo = buildCodexArgs(makeTurnInput())
    expect(argsRo).toContain('exec')
    expect(argsRo).toContain('--json')
    expect(argsRo).toContain('--model')
    expect(argsRo).toContain('o4-mini')
    expect(argsRo).toContain('--sandbox')
    expect(argsRo).toContain('read-only')
    expect(argsRo).not.toContain('--full-auto')
    expect(argsRo[argsRo.length - 1]).toContain('READ-ONLY workspace access')

    const argsRw = buildCodexArgs(
      makeTurnInput({
        workspaceMode: 'shared-rw',
        isolation: {
          level: 'standard',
          cleanEnv: true,
          blockSubagents: true,
          writableDirs: ['/tmp/repo'],
          readonlyDirs: [],
          readableFiles: [],
          disallowedTools: [],
          allowedTools: []
        }
      })
    )
    expect(argsRw).toContain('--full-auto')
    expect(argsRw).not.toContain('--sandbox')
  })

  it('parseCodexEventLine parses reasoning, agent text, command execution, error, and usage', () => {
    expect(
      parseCodexEventLine(
        JSON.stringify({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'checking imports' } })
      )
    ).toEqual({ thinkingDelta: 'checking imports' })

    expect(
      parseCodexEventLine(
        JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done.' } })
      )
    ).toEqual({ textDelta: 'Done.' })

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: 'item.started',
          item: { id: 'c1', type: 'command_execution', command: 'ls -la' }
        })
      )
    ).toEqual({ toolStart: { id: 'c1', name: 'codex_shell', input: { command: 'ls -la' } } })

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'c1', type: 'command_execution', aggregated_output: 'README.md', exit_code: 0 }
        })
      )
    ).toEqual({
      toolResult: { id: 'c1', name: 'codex_shell', output: 'README.md', isError: false }
    })

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 45 }
        })
      )
    ).toEqual({
      usage: {
        inputTokens: 120,
        cacheReadTokens: 30,
        outputTokens: 45,
        contextUsedTokens: 150
      }
    })

    expect(parseCodexEventLine(JSON.stringify({ type: 'error', message: 'rate limit' }))).toEqual({
      errorText: 'rate limit'
    })
    expect(parseCodexEventLine('not-json')).toBeNull()
  })

  it('buildAcpArgs configures stream-json, model, and plan mode when read-only', () => {
    const argsRo = buildAcpArgs(
      makeTurnInput({
        agent: {
          ...makeTurnInput().agent,
          driverKind: 'acp',
          driverConfig: { model: 'gemini-2.5-pro' }
        }
      })
    )
    expect(argsRo[0]).toBe('-p')
    expect(argsRo[1]).toContain('READ-ONLY workspace access')
    expect(argsRo).toContain('--output-format')
    expect(argsRo).toContain('stream-json')
    expect(argsRo).toContain('gemini-2.5-pro')
    expect(argsRo).toContain('--approval-mode')
    expect(argsRo).toContain('plan')
  })

  it('parseAcpEventLine parses message, thinking, tool_use, tool_result, error, and final result stats', () => {
    expect(
      parseAcpEventLine(JSON.stringify({ type: 'thinking', content: 'scanning AST' }))
    ).toEqual({ thinkingDelta: 'scanning AST' })

    expect(
      parseAcpEventLine(JSON.stringify({ type: 'message', role: 'assistant', content: 'Analysis OK' }))
    ).toEqual({ textDelta: 'Analysis OK' })

    expect(
      parseAcpEventLine(
        JSON.stringify({ type: 'tool_use', tool_id: 't1', tool_name: 'read_file', parameters: { path: 'a.ts' } })
      )
    ).toEqual({ toolStart: { id: 't1', name: 'read_file', input: { path: 'a.ts' } } })

    expect(
      parseAcpEventLine(
        JSON.stringify({ type: 'tool_result', tool_id: 't1', tool_name: 'read_file', output: 'ok', status: 'ok' })
      )
    ).toEqual({ toolResult: { id: 't1', name: 'read_file', output: 'ok', isError: false } })

    expect(
      parseAcpEventLine(
        JSON.stringify({
          type: 'result',
          response: 'Final verdict',
          stats: { input_tokens: 200, output_tokens: 50, duration_ms: 1400 }
        })
      )
    ).toEqual({
      done: true,
      textDelta: 'Final verdict',
      usage: { inputTokens: 200, outputTokens: 50, durationMs: 1400 }
    })

    expect(parseAcpEventLine(JSON.stringify({ type: 'error', error: 'auth failed' }))).toEqual({
      errorText: 'auth failed'
    })
  })
})
