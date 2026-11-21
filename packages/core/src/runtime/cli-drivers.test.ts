import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, Workspace } from '@myagents/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DaemonClient } from '../daemon-client'
import {
  AcpCliDriver,
  buildAcpArgs,
  buildCodexArgs,
  CodexCliDriver,
  combinePrompt,
  loadCodexMcpConfigArgs,
  parseAcpEventLine,
  parseCodexEventLine,
  serializeCodexMcpConfigArgs
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
  it('buildCodexArgs configures sandbox modes, skip-git-repo-check, and stdin prompt', () => {
    const roInput = makeTurnInput()
    const argsRo = buildCodexArgs(roInput)
    expect(argsRo).toContain('exec')
    expect(argsRo).toContain('--json')
    expect(argsRo).toContain('--skip-git-repo-check')
    expect(argsRo).toContain('--model')
    expect(argsRo).toContain('o4-mini')
    expect(argsRo).toContain('--sandbox')
    expect(argsRo).toContain('read-only')
    expect(argsRo).not.toContain('--full-auto')
    expect(argsRo).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argsRo[argsRo.length - 1]).toBe('-')
    expect(combinePrompt(roInput)).toContain('READ-ONLY workspace access')

    const standardIsolation = {
      level: 'standard' as const,
      cleanEnv: true,
      blockSubagents: true,
      writableDirs: ['/tmp/repo'],
      readonlyDirs: [],
      readableFiles: [],
      disallowedTools: [],
      allowedTools: []
    }

    const argsAgentRo = buildCodexArgs(
      makeTurnInput({
        workspaceMode: 'shared-rw',
        isolation: standardIsolation,
        agent: { ...makeTurnInput().agent, permissionMode: 'read-only' }
      })
    )
    expect(argsAgentRo).toContain('--sandbox')
    expect(argsAgentRo).toContain('read-only')

    const argsWorkspaceWrite = buildCodexArgs(
      makeTurnInput({
        workspaceMode: 'shared-rw',
        isolation: standardIsolation,
        agent: { ...makeTurnInput().agent, permissionMode: 'workspace-write' }
      })
    )
    expect(argsWorkspaceWrite).toContain('--sandbox')
    expect(argsWorkspaceWrite).toContain('workspace-write')
    expect(argsWorkspaceWrite).not.toContain('--full-auto')
    expect(argsWorkspaceWrite[argsWorkspaceWrite.length - 1]).toBe('-')

    const argsFull = buildCodexArgs(
      makeTurnInput({
        workspaceMode: 'shared-rw',
        isolation: standardIsolation
      })
    )
    expect(argsFull).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argsFull).not.toContain('--full-auto')
    expect(argsFull).not.toContain('--sandbox')
    expect(argsFull[argsFull.length - 1]).toBe('-')

    const argsResumeRo = buildCodexArgs(
      makeTurnInput({
        agent: { ...makeTurnInput().agent, isolationMode: 'isolated-home' }
      }),
      { resumeSessionId: 'thread-123' }
    )
    expect(argsResumeRo.slice(0, 4)).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check'])
    expect(argsResumeRo).toContain('sandbox_mode="read-only"')
    expect(argsResumeRo).not.toContain('--sandbox')
    expect(argsResumeRo).toContain('--ignore-user-config')
    expect(argsResumeRo).toContain('--ignore-rules')
    expect(argsResumeRo.slice(-2)).toEqual(['thread-123', '-'])

    const argsResumeRw = buildCodexArgs(
      makeTurnInput({
        workspaceMode: 'shared-rw',
        isolation: standardIsolation,
        agent: { ...makeTurnInput().agent, permissionMode: 'workspace-write' }
      }),
      { resumeSessionId: 'thread-456' }
    )
    expect(argsResumeRw).toContain('sandbox_mode="workspace-write"')
    expect(argsResumeRw).not.toContain('--ignore-user-config')
    expect(argsResumeRw.slice(-2)).toEqual(['thread-456', '-'])

    const argsLockdown = buildCodexArgs(
      makeTurnInput({
        isolation: { ...standardIsolation, level: 'lockdown' }
      })
    )
    expect(argsLockdown).toContain('--sandbox')
    expect(argsLockdown).toContain('read-only')
    expect(argsLockdown).toContain('--ignore-user-config')
    expect(argsLockdown).toContain('--ignore-rules')
  })

  it('serializeCodexMcpConfigArgs & loadCodexMcpConfigArgs handle stdio, http, and unsafe keys', () => {
    const args = serializeCodexMcpConfigArgs({
      myagents: {
        command: 'D:\\nodejs\\node.exe',
        args: ['G:\\bridge.mjs', '--room', 'r1'],
        env: { GOOD_KEY: 'val', 'BAD-KEY': 'skip' }
      },
      remote: { url: 'https://mcp.example.com/sse' },
      'bad.name': { command: 'node' }
    })
    expect(args).toEqual([
      '-c',
      'mcp_servers.myagents.command="D:\\\\nodejs\\\\node.exe"',
      '-c',
      'mcp_servers.myagents.args=["G:\\\\bridge.mjs","--room","r1"]',
      '-c',
      'mcp_servers.myagents.env.GOOD_KEY="val"',
      '-c',
      'mcp_servers.remote.url="https://mcp.example.com/sse"'
    ])
    expect(loadCodexMcpConfigArgs(path.join(os.tmpdir(), 'does-not-exist-mcp.json'))).toEqual([])
    expect(loadCodexMcpConfigArgs(undefined)).toEqual([])
  })

  it('combinePrompt handles resume mode, single-chat history fallback, and multi-agent transcript dedup', () => {
    const base = makeTurnInput({
      instruction: 'What is my name?',
      historyMessages: [
        {
          id: 'h1',
          roomId: 'r1',
          seq: 1,
          visibleSeq: 1,
          authorKind: 'human',
          authorId: 'admin',
          authorName: 'admin',
          kind: 'chat',
          content: 'My name is Alice.',
          attachments: [],
          replyToMsgId: null,
          workNodeId: null,
          visibilityScope: 'public',
          visibleTo: [],
          meta: {},
          createdAt: 1
        },
        {
          id: 'h2',
          roomId: 'r1',
          seq: 2,
          visibleSeq: 2,
          authorKind: 'agent',
          authorId: 'm1',
          authorName: 'Worker',
          kind: 'chat',
          content: 'Nice to meet you, Alice.',
          attachments: [],
          replyToMsgId: null,
          workNodeId: null,
          visibilityScope: 'public',
          visibleTo: [],
          meta: {},
          createdAt: 2
        },
        {
          id: 'h3',
          roomId: 'r1',
          seq: 3,
          visibleSeq: 3,
          authorKind: 'human',
          authorId: 'admin',
          authorName: 'admin',
          kind: 'chat',
          content: 'What is my name?',
          attachments: [],
          replyToMsgId: null,
          workNodeId: null,
          visibilityScope: 'public',
          visibleTo: [],
          meta: {},
          createdAt: 3
        }
      ]
    })

    const resumedPrompt = combinePrompt(base, { isResume: true })
    expect(resumedPrompt).not.toContain('[System Context]')
    expect(resumedPrompt).not.toContain('[Conversation History]')
    expect(resumedPrompt).toContain('READ-ONLY workspace access')
    expect(resumedPrompt).toContain('What is my name?')

    const freshPrompt = combinePrompt(base, { isResume: false })
    expect(freshPrompt).toContain('[System Context]\nBe concise.')
    expect(freshPrompt).toContain(
      '[Conversation History]\n[admin]: My name is Alice.\n[Worker]: Nice to meet you, Alice.'
    )
    expect(freshPrompt.match(/What is my name\?/g)?.length).toBe(1)

    const multiAgentPrompt = combinePrompt({
      ...base,
      systemContextPrompt: '# Collaboration Room\n\n## Visible Room Transcript (recent)\n#m1 [admin]: hi'
    })
    expect(multiAgentPrompt).not.toContain('[Conversation History]')
  })

  it('parseCodexEventLine parses reasoning, agent text, command execution, file_change, mcp_tool_call, error, turn.failed, and usage', () => {
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
          type: 'item.started',
          item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] }
        })
      )
    ).toEqual({
      toolStart: { id: 'f1', name: 'codex_file_change', input: { changes: [{ path: 'a.ts', kind: 'update' }] } }
    })

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'failed' }
        })
      )
    ).toEqual({
      toolResult: {
        id: 'f1',
        name: 'codex_file_change',
        output: JSON.stringify([{ path: 'a.ts', kind: 'update' }]),
        isError: true
      }
    })

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: 'item.started',
          item: { id: 't1', type: 'mcp_tool_call', tool: 'collab_reply', arguments: { text: 'hi' } }
        })
      )
    ).toEqual({
      toolStart: { id: 't1', name: 'collab_reply', input: { text: 'hi' } }
    })

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 't1', type: 'mcp_tool_call', tool: 'collab_reply', result: 'ok', status: 'completed' }
        })
      )
    ).toEqual({
      toolResult: { id: 't1', name: 'collab_reply', output: 'ok', isError: false }
    })

    expect(
      parseCodexEventLine(
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 120,
            cached_input_tokens: 30,
            cache_write_input_tokens: 10,
            output_tokens: 45,
            reasoning_output_tokens: 15
          }
        })
      )
    ).toEqual({
      usage: {
        inputTokens: 120,
        cacheReadTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 45,
        thinkingTokens: 15,
        contextUsedTokens: 150
      }
    })

    expect(parseCodexEventLine(JSON.stringify({ type: 'thread.started', thread_id: 'th-123' }))).toEqual({
      nativeSessionId: 'th-123'
    })
    expect(parseCodexEventLine(JSON.stringify({ type: 'error', message: 'rate limit' }))).toEqual({
      errorText: 'rate limit'
    })
    expect(parseCodexEventLine(JSON.stringify({ type: 'turn.failed', error: { message: 'auth expired' } }))).toEqual({
      errorText: 'auth expired'
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
    expect(parseAcpEventLine(JSON.stringify({ type: 'thinking', content: 'scanning AST' }))).toEqual({
      thinkingDelta: 'scanning AST'
    })

    expect(parseAcpEventLine(JSON.stringify({ type: 'message', role: 'assistant', content: 'Analysis OK' }))).toEqual({
      textDelta: 'Analysis OK'
    })

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

function createFakeCliCommand(dir: string, name: string, jsBody: string): string {
  const mjsFile = `${name}.mjs`
  const mjsPath = path.join(dir, mjsFile)
  if (process.platform === 'win32') {
    writeFileSync(mjsPath, jsBody, 'utf8')
    const cmdPath = path.join(dir, `${name}.cmd`)
    const shim = [
      `@IF EXIST "%~dp0\\node.exe" (`,
      `"%~dp0\\node.exe" "%~dp0\\${mjsFile}" %*`,
      `) ELSE (`,
      `SET PATHEXT=%PATHEXT:;.JS;=;%`,
      `node "%~dp0\\${mjsFile}" %*`,
      `)`
    ].join('\r\n')
    writeFileSync(cmdPath, shim, 'utf8')
    return cmdPath
  }
  writeFileSync(mjsPath, `#!/usr/bin/env node\n${jsBody}`, 'utf8')
  chmodSync(mjsPath, 0o755)
  return mjsPath
}

describe('CodexCliDriver & AcpCliDriver daemon integration', () => {
  let tmpDir: string
  let workDir: string
  let daemonProc: ChildProcess
  let daemon: DaemonClient
  let fakeCodexCmd: string
  let fakeResumeCmd: string
  let fakeAcpCmd: string
  let fakeFailCmd: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-cli-drivers-'))
    workDir = path.join(tmpDir, 'workspace')
    mkdirSync(workDir, { recursive: true })

    fakeCodexCmd = createFakeCliCommand(
      tmpDir,
      'fake-codex',
      `
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  if (!process.argv.includes('-')) {
    process.stderr.write('missing "-" prompt arg\\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't-1' }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text: 'ECHO:' + stdin }
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 3 }
  }))
  process.exit(0)
})
`
    )

    fakeResumeCmd = createFakeCliCommand(
      tmpDir,
      'fake-resume',
      `
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  const args = process.argv.slice(2)
  if (args.includes('resume') && args.includes('missing-thread')) {
    process.stderr.write('thread not found: missing-thread\\n')
    process.exit(1)
  }
  const tid = args.includes('resume') ? 'thread-abc' : 'thread-abc'
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: tid }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text: JSON.stringify({ args, stdin }) }
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 }
  }) + '\\n')
  process.exit(0)
})
`
    )

    fakeAcpCmd = createFakeCliCommand(
      tmpDir,
      'fake-acp',
      `
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: 'ACP_OK:' + stdin.length
  }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'result',
    stats: { input_tokens: 7, output_tokens: 3, duration_ms: 12 }
  }) + '\\n')
  process.exit(0)
})
`
    )

    fakeFailCmd = createFakeCliCommand(
      tmpDir,
      'fake-fail',
      `
process.stderr.write('fatal fast error from cli\\n')
process.exit(2)
`
    )

    const daemonEndpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\myagents-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
        : path.join(tmpDir, 'daemon.sock')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const daemonEntry = path.resolve(here, '../../../daemon/src/main.ts')
    daemonProc = spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
      env: { ...process.env, MYAGENTS_DAEMON_ENDPOINT: daemonEndpoint },
      stdio: 'pipe',
      windowsHide: true
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon startup timeout')), 10_000)
      daemonProc.stdout?.on('data', (d) => {
        if (String(d).includes('listening on')) {
          clearTimeout(timer)
          resolve()
        }
      })
      daemonProc.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`daemon exited early: ${code}`))
      })
    })

    daemon = new DaemonClient(daemonEndpoint)
    await daemon.connect(false)
  })

  afterAll(() => {
    daemon?.close()
    if (daemonProc && daemonProc.exitCode === null) {
      daemonProc.kill()
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('CodexCliDriver delivers prompt via stdin with EOF and flushes trailing JSONL on exit', async () => {
    const driver = new CodexCliDriver(daemon)
    const base = makeTurnInput()
    const events: string[] = []
    const output = await driver.runTurn({
      ...base,
      agent: { ...base.agent, driverConfig: { cliPath: fakeCodexCmd, model: 'o4-mini' } },
      workspace: { ...base.workspace, rootPath: workDir },
      emit: (ev) => {
        if (ev.kind === 'text' && ev.delta) events.push(ev.delta)
      }
    })

    expect(output.finalText).toContain('ECHO:')
    expect(output.finalText).toContain('[System Context]\nBe concise.')
    expect(output.finalText).toContain('READ-ONLY workspace access')
    expect(output.finalText).toContain('Analyze module')
    expect(events.join('')).toBe(output.finalText)
    expect(output.usage).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 2,
      outputTokens: 5,
      thinkingTokens: 3,
      contextUsedTokens: 12
    })
  }, 5000)

  it('AcpCliDriver closes stdin immediately so CLI reading stdin EOF does not hang', async () => {
    const driver = new AcpCliDriver(daemon)
    const base = makeTurnInput()
    const output = await driver.runTurn({
      ...base,
      agent: {
        ...base.agent,
        driverKind: 'acp',
        driverConfig: { cliPath: fakeAcpCmd, model: 'gemini-2.5-pro' }
      },
      workspace: { ...base.workspace, rootPath: workDir }
    })

    expect(output.finalText).toBe('ACP_OK:0')
    expect(output.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      durationMs: 12
    })
  }, 5000)

  it('captures stderr and exit code when CLI fails immediately without dropping fast events', async () => {
    const driver = new CodexCliDriver(daemon)
    const base = makeTurnInput()
    await expect(
      driver.runTurn({
        ...base,
        agent: { ...base.agent, driverConfig: { cliPath: fakeFailCmd } },
        workspace: { ...base.workspace, rootPath: workDir }
      })
    ).rejects.toThrow(/exited with code 2.*fatal fast error from cli/)
  }, 5000)

  it('CodexCliDriver persists thread_id and uses exec resume with incremental prompt on turn 2', async () => {
    const driver = new CodexCliDriver(daemon)
    const base = makeTurnInput()
    let savedNativeId: string | null = null
    let savedConfigHash: string | null = null

    const turn1 = await driver.runTurn({
      ...base,
      agent: { ...base.agent, driverConfig: { cliPath: fakeResumeCmd } },
      workspace: { ...base.workspace, rootPath: workDir },
      instruction: 'First turn prompt',
      onSessionUpdate: (patch) => {
        if (patch.nativeSessionId !== undefined) savedNativeId = patch.nativeSessionId
        if (patch.configHash !== undefined) savedConfigHash = patch.configHash
      }
    })
    expect(turn1.nativeSessionId).toBe('thread-abc')
    expect(savedNativeId).toBe('thread-abc')
    expect(savedConfigHash).toBe(base.configHash)

    const turn2 = await driver.runTurn({
      ...base,
      session: {
        ...base.session,
        nativeSessionId: savedNativeId,
        configHash: savedConfigHash
      },
      agent: { ...base.agent, driverConfig: { cliPath: fakeResumeCmd } },
      workspace: { ...base.workspace, rootPath: workDir },
      instruction: 'Follow-up turn'
    })

    const payload = JSON.parse(turn2.finalText) as { args: string[]; stdin: string }
    expect(payload.args.slice(0, 4)).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check'])
    expect(payload.args.slice(-2)).toEqual(['thread-abc', '-'])
    expect(payload.stdin).not.toContain('[System Context]')
    expect(payload.stdin).toContain('Follow-up turn')
  }, 5000)

  it('CodexCliDriver falls back to fresh exec when resume reports missing thread', async () => {
    const driver = new CodexCliDriver(daemon)
    const base = makeTurnInput()
    const updates: Array<string | null | undefined> = []

    const output = await driver.runTurn({
      ...base,
      session: {
        ...base.session,
        nativeSessionId: 'missing-thread',
        configHash: base.configHash
      },
      agent: { ...base.agent, driverConfig: { cliPath: fakeResumeCmd } },
      workspace: { ...base.workspace, rootPath: workDir },
      instruction: 'Recover fresh',
      onSessionUpdate: (patch) => {
        if ('nativeSessionId' in patch) updates.push(patch.nativeSessionId)
      }
    })

    const payload = JSON.parse(output.finalText) as { args: string[]; stdin: string }
    expect(payload.args[0]).toBe('exec')
    expect(payload.args).not.toContain('resume')
    expect(payload.stdin).toContain('[System Context]\nBe concise.')
    expect(payload.stdin).toContain('Recover fresh')
    expect(updates).toContain(null)
    expect(output.nativeSessionId).toBe('thread-abc')
  }, 5000)

  it('CodexCliDriver injects dynamic MCP server overrides from mcpConfigPath', async () => {
    const driver = new CodexCliDriver(daemon)
    const base = makeTurnInput()
    const mcpPath = path.join(tmpDir, 'mcp-config.json')
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          myagents: {
            command: process.execPath,
            args: ['G:\\bridge.mjs', '--room', 'r1', '--member', 'm1']
          }
        }
      }),
      'utf8'
    )

    const output = await driver.runTurn({
      ...base,
      mcpConfigPath: mcpPath,
      agent: { ...base.agent, driverConfig: { cliPath: fakeResumeCmd } },
      workspace: { ...base.workspace, rootPath: workDir },
      instruction: 'Check MCP args'
    })

    const payload = JSON.parse(output.finalText) as { args: string[]; stdin: string }
    expect(payload.args).toContain(`mcp_servers.myagents.command=${JSON.stringify(process.execPath)}`)
    expect(payload.args).toContain('mcp_servers.myagents.args=["G:\\\\bridge.mjs","--room","r1","--member","m1"]')
  }, 5000)
})
