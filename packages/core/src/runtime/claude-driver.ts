import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DriverCapabilities, TurnUsage } from '@myagents/protocol'
import type { DaemonEvent } from '@myagents/protocol/node'
import type { DaemonClient } from '../daemon-client'
import { Errors } from '../errors'
import { isPathOverlapping } from '../workspace/path-guard'
import type { AgentDriver, SessionRecord, TurnInput, TurnOutput } from './driver'
import { claudeRulePath } from './environment-isolator'

export function resolveClaudeSessionFilePath(
  workspaceRootPath: string,
  nativeSessionId: string | null,
  configHomeDir?: string | null
): string | null {
  if (!nativeSessionId) return null
  const configDir = configHomeDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
  const projectsDir = path.join(configDir, 'projects')
  const encoded = path.resolve(workspaceRootPath).replace(/[^a-zA-Z0-9-]/g, '-')
  const filename = `${nativeSessionId}.jsonl`
  const direct = path.join(projectsDir, encoded, filename)
  if (fs.existsSync(direct)) return direct

  try {
    if (fs.existsSync(projectsDir)) {
      const dirs = fs.readdirSync(projectsDir)
      const encodedLower = encoded.toLowerCase()
      const ciMatch = dirs.find((d) => d.toLowerCase() === encodedLower)
      if (ciMatch) {
        const ciPath = path.join(projectsDir, ciMatch, filename)
        if (fs.existsSync(ciPath)) return ciPath
      }
      for (const d of dirs) {
        const candidate = path.join(projectsDir, d, filename)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  } catch {
    // fallback to canonical path
  }
  return direct
}

function inferContextWindow(model?: string, modelUsage?: Record<string, { contextWindow?: number }>): number | undefined {
  if (modelUsage) {
    if (model && typeof modelUsage[model]?.contextWindow === 'number' && modelUsage[model]!.contextWindow! > 0) {
      return modelUsage[model]!.contextWindow
    }
    let maxWin = 0
    for (const entry of Object.values(modelUsage)) {
      if (typeof entry?.contextWindow === 'number' && entry.contextWindow > maxWin) {
        maxWin = entry.contextWindow
      }
    }
    if (maxWin > 0) return maxWin
  }
  if (!model) return undefined
  if (/\[1m\]/i.test(model)) return 1_000_000
  if (/claude/i.test(model)) return 200_000
  return undefined
}

function buildClaudeArgs(input: TurnInput, sessionId: string, isResume: boolean): string[] {
  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio'
  ]

  const isLockdown = input.isolation.level === 'lockdown'
  const readOnly = input.isolation.level !== 'standard' || input.workspaceMode === 'read-only'
  if (isLockdown) {
    args.push(
      '--permission-mode',
      'plan',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-chrome'
    )
  } else if (readOnly) {
    args.push('--permission-mode', 'plan')
  } else if (input.agent.permissionMode === 'full') {
    args.push('--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions')
  } else {
    args.push('--permission-mode', 'acceptEdits')
  }

  if (input.agent.driverConfig.model) {
    args.push('--model', input.agent.driverConfig.model)
  }
  if (input.agent.driverConfig.effort) {
    args.push('--effort', input.agent.driverConfig.effort)
  }

  if (isResume) {
    args.push('--resume', sessionId)
  } else {
    args.push('--session-id', sessionId)
  }

  const systemParts = [
    input.agent.systemPrompt?.trim(),
    input.skillsPrompt?.trim(),
    input.systemContextPrompt?.trim()
  ].filter(Boolean)
  if (systemParts.length > 0) {
    args.push('--append-system-prompt', systemParts.join('\n\n'))
  }

  const mcpConfigPath = input.mcpConfigPath || input.isolation.mcpConfigPath
  if (mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath)
  }

  const allowed = [...input.isolation.allowedTools]
  if (allowed.length > 0) {
    args.push('--allowedTools', [...new Set(allowed)].join(','))
  }

  const disallowed = [...input.isolation.disallowedTools]
  if (readOnly) {
    const p = claudeRulePath(input.workspace.rootPath)
    if (p) {
      disallowed.push(`Edit(/${p.replace(/\/$/, '')}/**)`, `Write(/${p.replace(/\/$/, '')}/**)`)
    }
  }
  if (disallowed.length > 0) {
    args.push('--disallowedTools', [...new Set(disallowed)].join(','))
  }

  return args
}

export class ClaudeCodeDriver implements AgentDriver {
  readonly kind = 'claude' as const
  readonly capabilities: DriverCapabilities = {
    supportsNativeResume: true,
    supportsSteerWhileRunning: false,
    supportsReadOnlyEnforcement: true,
    supportsDynamicMcp: true,
    supportsSubagentBlock: true
  }

  constructor(private readonly daemon: DaemonClient) {}

  async runTurn(input: TurnInput): Promise<TurnOutput> {
    const startedAt = Date.now()
    const command = input.agent.driverConfig.cliPath?.trim() || 'claude'
    let daemonSessionId = input.session.daemonSessionId
    let nativeSessionId = input.session.nativeSessionId || randomUUID()
    let needsSpawn = true

    // Reuse existing live daemon pipe session if configHash matches
    if (daemonSessionId && input.session.configHash === input.configHash) {
      try {
        const list = await this.daemon.call('list', {})
        const found = list.sessions.find((s) => s.sessionId === daemonSessionId && !s.exited)
        if (found) needsSpawn = false
      } catch {
        needsSpawn = true
      }
    } else if (daemonSessionId) {
      // Config drifted -> cleanly retire old process before spawning with resume
      await this.daemon.call('release', { sessionId: daemonSessionId }).catch(() => {})
      daemonSessionId = null
    }

    if (needsSpawn) {
      const isResume = Boolean(input.session.nativeSessionId)
      daemonSessionId = `claude-${randomUUID()}`
      const args = buildClaudeArgs(input, nativeSessionId, isResume)
      const spawnMethod = input.isolation.cleanEnv ? 'spawnPipeClean' : 'spawnPipe'
      await this.daemon.call(spawnMethod, {
        sessionId: daemonSessionId,
        command,
        args,
        cwd: input.workspace.rootPath,
        env: { ...(input.isolation.envOverrides ?? {}) }
      })
      input.onSessionUpdate({
        daemonSessionId,
        nativeSessionId,
        configHash: input.configHash,
        lastConsumedOffset: 0
      })
    }

    const activeDaemonId = daemonSessionId!
    return await this.executeStreamTurn(activeDaemonId, nativeSessionId, needsSpawn, input, startedAt)
  }

  async disposeSession(session: SessionRecord): Promise<void> {
    if (session.daemonSessionId) {
      await this.daemon.call('release', { sessionId: session.daemonSessionId }).catch(() => {})
    }
  }

  private async executeStreamTurn(
    daemonSessionId: string,
    initialNativeSessionId: string,
    needsInit: boolean,
    input: TurnInput,
    startedAt: number
  ): Promise<TurnOutput> {
    let nativeSessionId = initialNativeSessionId
    let lineBuf = ''
    let accumulatedText = ''
    let stderrBuf = ''
    const seenToolIds = new Set<string>()
    let gotFirstFrame = false
    let userMessageSent = !needsInit
    const initRequestId = `myagents-init-${Date.now()}`
    let firstOutputAt: number | null = null
    let reportedModel: string | undefined = input.agent.driverConfig.model?.trim() || undefined
    let latestContextUsed: number | undefined
    let contextWindow: number | undefined = inferContextWindow(reportedModel)
    let sumOutputTokens = 0
    let sumThinkingTokens = 0
    let streamedThinkingInMsg = 0
    const seenUsageMsgIds = new Set<string>()

    const buildUsageSnapshot = (opts?: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
      thinkingTokens?: number
      costUsd?: number
      durationMs?: number
      numTurns?: number
    }): TurnUsage => {
      const now = Date.now()
      const durationMs = opts?.durationMs ?? Math.max(0, now - startedAt)
      const outputTokens = opts?.outputTokens ?? (sumOutputTokens || undefined)
      const thinkingTokens = opts?.thinkingTokens ?? (sumThinkingTokens || undefined)
      const genMs = firstOutputAt ? Math.max(100, now - firstOutputAt) : durationMs
      const tokensPerSec =
        outputTokens && outputTokens > 0 && genMs > 0
          ? Number((outputTokens / (genMs / 1000)).toFixed(1))
          : undefined
      const ttftMs = firstOutputAt ? Math.max(0, firstOutputAt - startedAt) : undefined
      return {
        model: reportedModel,
        inputTokens: opts?.inputTokens,
        outputTokens,
        cacheReadTokens: opts?.cacheReadTokens,
        cacheCreationTokens: opts?.cacheCreationTokens,
        thinkingTokens,
        contextUsedTokens: latestContextUsed,
        contextWindow: contextWindow ?? inferContextWindow(reportedModel),
        costUsd: opts?.costUsd,
        durationMs,
        ttftMs,
        tokensPerSec,
        numTurns: opts?.numTurns
      }
    }

    return await new Promise<TurnOutput>((resolve, reject) => {
      let settled = false

      const sendUserFrame = () => {
        if (userMessageSent || settled) return
        userMessageSent = true
        const userFrame = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: input.instruction }
        })
        this.daemon.call('write', { sessionId: daemonSessionId, data: `${userFrame}\n` }).catch((err) => {
          fail(Errors.driverError(`Failed writing to Claude CLI: ${err instanceof Error ? err.message : String(err)}`))
        })
      }

      const cleanup = () => {
        unsub()
        clearTimeout(firstFrameTimer)
        clearTimeout(idleTimer)
        input.abortSignal.removeEventListener('abort', onAbort)
      }

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      const succeed = (finalText: string, usage?: TurnUsage) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          finalText: finalText || accumulatedText || '(Completed)',
          nativeSessionId,
          usage: usage ?? buildUsageSnapshot()
        })
      }

      const resetIdleTimer = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          void this.daemon.call('kill', { sessionId: daemonSessionId }).catch(() => {})
          fail(Errors.driverError('Claude Code CLI idle timeout (300s)'))
        }, 300_000)
      }

      const firstFrameTimer = setTimeout(() => {
        if (!gotFirstFrame && !settled) {
          void this.daemon.call('kill', { sessionId: daemonSessionId }).catch(() => {})
          fail(Errors.driverError(`Claude Code CLI did not respond within 60s.${stderrBuf ? ` stderr: ${stderrBuf.slice(0, 400)}` : ''}`))
        }
      }, 60_000)

      let idleTimer = setTimeout(() => {}, 300_000)
      resetIdleTimer()

      const onAbort = () => {
        // Send interrupt control request, then kill if still running
        const interruptFrame = JSON.stringify({
          type: 'control_request',
          request_id: `interrupt-${Date.now()}`,
          request: { subtype: 'interrupt' }
        })
        void this.daemon.call('write', { sessionId: daemonSessionId, data: `${interruptFrame}\n` }).catch(() => {})
        setTimeout(() => {
          void this.daemon.call('kill', { sessionId: daemonSessionId }).catch(() => {})
        }, 1200)
        fail(new Error('aborted'))
      }
      input.abortSignal.addEventListener('abort', onAbort, { once: true })

      const handleJsonLine = (raw: string) => {
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return
        }

        gotFirstFrame = true
        resetIdleTimer()

        const type = frame.type
        if (type === 'control_response') {
          const resp = (frame.response ?? {}) as { request_id?: string; subtype?: string; error?: string }
          if (resp.request_id === initRequestId) {
            if (resp.subtype !== 'success') {
              fail(Errors.driverError(`Claude CLI initialize failed: ${resp.error || 'unknown error'}`))
            } else {
              sendUserFrame()
            }
          }
          return
        }

        if (type === 'system') {
          if (typeof frame.session_id === 'string' && frame.session_id) {
            nativeSessionId = frame.session_id
            input.onSessionUpdate({ nativeSessionId })
          }
          if (typeof frame.model === 'string' && frame.model) {
            reportedModel = frame.model
            contextWindow = contextWindow ?? inferContextWindow(reportedModel)
            input.emit({ kind: 'usage', usage: buildUsageSnapshot() })
          }
          return
        }

        // Auto-respond to stdio permission control requests in v0.1a
        if (type === 'control_request' && typeof frame.request_id === 'string') {
          const req = (frame.request ?? {}) as Record<string, unknown>
          if (req.subtype === 'can_use_tool') {
            const readOnly = input.isolation.level !== 'standard' || input.workspaceMode === 'read-only'
            const toolName = String(req.tool_name ?? '')
            const toolInput = (req.input ?? {}) as Record<string, unknown>
            const targetFile =
              typeof toolInput.file_path === 'string'
                ? toolInput.file_path
                : typeof toolInput.path === 'string'
                  ? toolInput.path
                  : null
            const blockedBySubagent = input.isolation.blockSubagents && (toolName === 'Agent' || toolName === 'Task')
            const isEditTool = ['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit'].includes(toolName)
            const blockedByReadonlyDir =
              isEditTool &&
              Boolean(targetFile) &&
              input.isolation.readonlyDirs.some((d) => isPathOverlapping(path.resolve(input.workspace.rootPath, targetFile!), d))
            const blockedByReadOnly = (readOnly && isEditTool) || blockedByReadonlyDir
            const response = blockedBySubagent || blockedByReadOnly
              ? {
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: frame.request_id,
                    response: {
                      behavior: 'deny',
                      message: blockedBySubagent
                        ? 'Subagent spawning is disabled.'
                        : blockedByReadonlyDir
                          ? 'Target directory is read-only.'
                          : 'Workspace is read-only.'
                    }
                  }
                }
              : {
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: frame.request_id,
                    response: { behavior: 'allow', updatedInput: req.input ?? {} }
                  }
                }
            void this.daemon.call('write', { sessionId: daemonSessionId, data: `${JSON.stringify(response)}\n` }).catch(() => {})
          } else {
            const errResp = {
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: frame.request_id,
                error: `Unsupported control request: ${String(req.subtype ?? 'unknown')}`
              }
            }
            void this.daemon.call('write', { sessionId: daemonSessionId, data: `${JSON.stringify(errResp)}\n` }).catch(() => {})
          }
          return
        }

        if (type === 'stream_event') {
          const ev = (frame.event ?? {}) as Record<string, unknown>
          if (ev.type === 'message_start') {
            streamedThinkingInMsg = 0
            const msg = (ev.message ?? {}) as {
              model?: string
              usage?: {
                input_tokens?: number
                cache_creation_input_tokens?: number
                cache_read_input_tokens?: number
              }
            }
            if (typeof msg.model === 'string' && msg.model) {
              reportedModel = msg.model
              contextWindow = contextWindow ?? inferContextWindow(reportedModel)
            }
            if (msg.usage) {
              const used =
                (msg.usage.input_tokens ?? 0) +
                (msg.usage.cache_creation_input_tokens ?? 0) +
                (msg.usage.cache_read_input_tokens ?? 0)
              if (used > 0) {
                latestContextUsed = used
                input.emit({
                  kind: 'usage',
                  usage: buildUsageSnapshot({
                    inputTokens: msg.usage.input_tokens,
                    cacheCreationTokens: msg.usage.cache_creation_input_tokens,
                    cacheReadTokens: msg.usage.cache_read_input_tokens
                  })
                })
              }
            }
            return
          }
          if (ev.type === 'message_delta') {
            const u = (ev.usage ?? {}) as {
              input_tokens?: number
              output_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
            }
            const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            if (used > 0) latestContextUsed = used
            if (used > 0 || (typeof u.output_tokens === 'number' && u.output_tokens > 0)) {
              input.emit({
                kind: 'usage',
                usage: buildUsageSnapshot({
                  inputTokens: u.input_tokens,
                  outputTokens: u.output_tokens ? sumOutputTokens + u.output_tokens : undefined,
                  cacheCreationTokens: u.cache_creation_input_tokens,
                  cacheReadTokens: u.cache_read_input_tokens
                })
              })
            }
            return
          }
          if (ev.type === 'content_block_delta') {
            const delta = (ev.delta ?? {}) as Record<string, unknown>
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              firstOutputAt ??= Date.now()
              accumulatedText += delta.text
              input.emit({ kind: 'text', delta: delta.text })
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              firstOutputAt ??= Date.now()
              streamedThinkingInMsg += delta.thinking.length
              input.emit({ kind: 'thinking', delta: delta.thinking })
            }
          }
          return
        }

        if (type === 'assistant') {
          const message = (frame.message ?? {}) as {
            id?: string
            model?: string
            content?: Array<Record<string, unknown>>
            usage?: {
              input_tokens?: number
              output_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
              output_tokens_details?: { thinking_tokens?: number }
            }
          }
          if (typeof message.model === 'string' && message.model) {
            reportedModel = message.model
            contextWindow = contextWindow ?? inferContextWindow(reportedModel)
          }
          if (message.usage) {
            const u = message.usage
            const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
            if (used > 0) latestContextUsed = used
            const msgId = typeof message.id === 'string' ? message.id : null
            if (!msgId || !seenUsageMsgIds.has(msgId)) {
              if (msgId) seenUsageMsgIds.add(msgId)
              if (typeof u.output_tokens === 'number') sumOutputTokens += u.output_tokens
              if (typeof u.output_tokens_details?.thinking_tokens === 'number') {
                sumThinkingTokens += u.output_tokens_details.thinking_tokens
              }
            }
            input.emit({
              kind: 'usage',
              usage: buildUsageSnapshot({
                inputTokens: u.input_tokens,
                outputTokens: sumOutputTokens || u.output_tokens,
                cacheCreationTokens: u.cache_creation_input_tokens,
                cacheReadTokens: u.cache_read_input_tokens,
                thinkingTokens: sumThinkingTokens || u.output_tokens_details?.thinking_tokens
              })
            })
          }
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
                firstOutputAt ??= Date.now()
                if (streamedThinkingInMsg === 0) {
                  input.emit({ kind: 'thinking', delta: block.thinking })
                }
              } else if (block.type === 'tool_use' && typeof block.id === 'string' && !seenToolIds.has(block.id)) {
                seenToolIds.add(block.id)
                input.emit({
                  kind: 'tool_start',
                  toolCall: {
                    id: block.id,
                    name: String(block.name ?? 'tool'),
                    input: block.input
                  }
                })
              } else if (block.type === 'text' && typeof block.text === 'string' && !accumulatedText) {
                firstOutputAt ??= Date.now()
                // Fallback if partial messages didn't stream text
                accumulatedText = block.text
                input.emit({ kind: 'text', delta: block.text })
              }
            }
          }
          streamedThinkingInMsg = 0
          return
        }

        if (type === 'user') {
          const message = (frame.message ?? {}) as { content?: Array<Record<string, unknown>> }
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const rawContent = block.content
                const outText =
                  typeof rawContent === 'string'
                    ? rawContent
                    : Array.isArray(rawContent)
                      ? rawContent.map((c) => (typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : JSON.stringify(c))).join('\n')
                      : JSON.stringify(rawContent ?? '')
                input.emit({
                  kind: 'tool_result',
                  toolCall: {
                    id: block.tool_use_id,
                    name: 'tool',
                    output: outText.slice(0, 16_000),
                    isError: Boolean(block.is_error)
                  }
                })
              }
            }
          }
          return
        }

        if (type === 'result') {
          if (typeof frame.session_id === 'string' && frame.session_id) {
            nativeSessionId = frame.session_id
            input.onSessionUpdate({ nativeSessionId })
          }
          const isError = Boolean(frame.is_error)
          const resultText = typeof frame.result === 'string' ? frame.result : ''
          const usage = (frame.usage ?? {}) as {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
            output_tokens_details?: { thinking_tokens?: number }
          }
          const modelUsage = frame.modelUsage as Record<string, { contextWindow?: number }> | undefined
          const resolvedWin = inferContextWindow(reportedModel, modelUsage)
          if (resolvedWin) contextWindow = resolvedWin
          if (!latestContextUsed) {
            const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
            const turns = typeof frame.num_turns === 'number' && frame.num_turns > 1 ? frame.num_turns : 1
            if (used > 0) latestContextUsed = Math.round(used / turns)
          }
          if (isError) {
            fail(Errors.driverError(resultText || 'Claude Code returned an error result'))
          } else {
            succeed(
              resultText || accumulatedText,
              buildUsageSnapshot({
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens ?? (sumOutputTokens || undefined),
                cacheReadTokens: usage.cache_read_input_tokens,
                cacheCreationTokens: usage.cache_creation_input_tokens,
                thinkingTokens: usage.output_tokens_details?.thinking_tokens ?? (sumThinkingTokens || undefined),
                costUsd: typeof frame.total_cost_usd === 'number' ? frame.total_cost_usd : undefined,
                durationMs: typeof frame.duration_ms === 'number' ? frame.duration_ms : undefined,
                numTurns: typeof frame.num_turns === 'number' ? frame.num_turns : undefined
              })
            )
          }
        }
      }

      const unsub = this.daemon.onEvent((ev: DaemonEvent) => {
        if (ev.sessionId !== daemonSessionId) return
        if (ev.event === 'stderr') {
          stderrBuf += ev.data
          if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
          return
        }
        if (ev.event === 'data') {
          input.onSessionUpdate({ lastConsumedOffset: ev.offset + ev.data.length })
          lineBuf += ev.data
          let nl = lineBuf.indexOf('\n')
          while (nl !== -1) {
            const line = lineBuf.slice(0, nl).trim()
            lineBuf = lineBuf.slice(nl + 1)
            if (line) handleJsonLine(line)
            nl = lineBuf.indexOf('\n')
          }
          return
        }
        if (ev.event === 'exit') {
          input.onSessionUpdate({ daemonSessionId: null })
          if (!settled) {
            if (ev.exitCode === 0 && accumulatedText) {
              succeed(accumulatedText)
            } else {
              fail(
                Errors.driverError(
                  `Claude Code CLI exited with code ${ev.exitCode}${stderrBuf ? `: ${stderrBuf.trim().slice(0, 500)}` : ''}`
                )
              )
            }
          }
        }
      })

      // Send initialize handshake on fresh CLI process, then user prompt on control_response;
      // for an already-initialized live session, send the user frame immediately.
      if (needsInit) {
        const initFrame = JSON.stringify({
          type: 'control_request',
          request_id: initRequestId,
          request: { subtype: 'initialize' }
        })
        this.daemon.call('write', { sessionId: daemonSessionId, data: `${initFrame}\n` }).catch((err) => {
          fail(Errors.driverError(`Failed initializing Claude CLI: ${err instanceof Error ? err.message : String(err)}`))
        })
      } else {
        userMessageSent = false
        sendUserFrame()
      }
    })
  }
}
