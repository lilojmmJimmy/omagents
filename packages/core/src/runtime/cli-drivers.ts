import { randomUUID } from 'node:crypto'
import type { DriverCapabilities, TurnUsage } from '@myagents/protocol'
import { DAEMON_PROTOCOL_VERSION, type DaemonEvent } from '@myagents/protocol/node'
import type { DaemonClient } from '../daemon-client'
import { Errors } from '../errors'
import type { AgentDriver, SessionRecord, TurnInput, TurnOutput } from './driver'

function isReadOnlyTurn(input: TurnInput): boolean {
  return (
    input.isolation.level !== 'standard' ||
    input.workspaceMode === 'read-only' ||
    input.agent.permissionMode === 'read-only'
  )
}

export function combinePrompt(input: TurnInput): string {
  const parts = [input.agent.systemPrompt?.trim(), input.systemContextPrompt?.trim()].filter(Boolean)
  const prefix = parts.length > 0 ? `[System Context]\n${parts.join('\n\n')}\n\n` : ''
  const guard = isReadOnlyTurn(input)
    ? '[Constraint: READ-ONLY workspace access. Do NOT edit files or run mutating commands.]\n\n'
    : ''
  return `${prefix}${guard}${input.instruction}`
}

export function buildCodexArgs(input: TurnInput): string[] {
  const readOnly = isReadOnlyTurn(input)
  const args: string[] = ['exec', '--json', '--skip-git-repo-check']
  if (input.agent.driverConfig.model?.trim()) {
    args.push('--model', input.agent.driverConfig.model.trim())
  }
  if (readOnly) {
    args.push('--sandbox', 'read-only')
  } else if (input.agent.permissionMode === 'full') {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    args.push('--sandbox', 'workspace-write')
  }
  args.push('-')
  return args
}

export function parseCodexEventLine(rawLine: string): {
  textDelta?: string
  thinkingDelta?: string
  toolStart?: { id: string; name: string; input?: unknown }
  toolResult?: { id: string; name: string; output?: string; isError?: boolean }
  usage?: TurnUsage
  errorText?: string
} | null {
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(rawLine) as Record<string, unknown>
  } catch {
    return null
  }
  const type = String(frame.type || '')
  if (type === 'error' && typeof frame.message === 'string') {
    return { errorText: frame.message }
  }
  if (type === 'turn.failed') {
    const errObj = (frame.error ?? {}) as { message?: unknown }
    const msg =
      typeof errObj.message === 'string'
        ? errObj.message
        : typeof frame.message === 'string'
          ? frame.message
          : 'Codex turn failed'
    return { errorText: msg }
  }
  if (type === 'item.completed' || type === 'item.started') {
    const item = (frame.item ?? {}) as Record<string, unknown>
    const itemType = String(item.type || '')
    const itemId = String(item.id || `codex-${Date.now()}`)
    if (itemType === 'reasoning' && typeof item.text === 'string' && type === 'item.completed') {
      return { thinkingDelta: item.text }
    }
    if (itemType === 'agent_message' && typeof item.text === 'string' && type === 'item.completed') {
      return { textDelta: item.text }
    }
    if (itemType === 'command_execution') {
      if (type === 'item.started') {
        return { toolStart: { id: itemId, name: 'codex_shell', input: { command: item.command } } }
      }
      return {
        toolResult: {
          id: itemId,
          name: 'codex_shell',
          output: String(item.aggregated_output ?? ''),
          isError: typeof item.exit_code === 'number' && item.exit_code !== 0
        }
      }
    }
    if (itemType === 'file_change') {
      if (type === 'item.started') {
        return { toolStart: { id: itemId, name: 'codex_file_change', input: { changes: item.changes } } }
      }
      return {
        toolResult: {
          id: itemId,
          name: 'codex_file_change',
          output: JSON.stringify(item.changes ?? []),
          isError: item.status === 'failed'
        }
      }
    }
    if (itemType === 'mcp_tool_call') {
      const toolName = String(item.tool || 'mcp_tool')
      if (type === 'item.started') {
        return { toolStart: { id: itemId, name: toolName, input: item.arguments } }
      }
      return {
        toolResult: {
          id: itemId,
          name: toolName,
          output: typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? item.error ?? ''),
          isError: item.status === 'failed' || Boolean(item.error)
        }
      }
    }
  }
  if (type === 'turn.completed' && frame.usage && typeof frame.usage === 'object') {
    const u = frame.usage as {
      input_tokens?: number
      cached_input_tokens?: number
      cache_write_input_tokens?: number
      output_tokens?: number
      reasoning_output_tokens?: number
    }
    return {
      usage: {
        inputTokens: u.input_tokens,
        cacheReadTokens: u.cached_input_tokens,
        ...(typeof u.cache_write_input_tokens === 'number'
          ? { cacheCreationTokens: u.cache_write_input_tokens }
          : {}),
        outputTokens: u.output_tokens,
        ...(typeof u.reasoning_output_tokens === 'number'
          ? { thinkingTokens: u.reasoning_output_tokens }
          : {}),
        contextUsedTokens: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0)
      }
    }
  }
  return null
}

export function buildAcpArgs(input: TurnInput): string[] {
  const readOnly = isReadOnlyTurn(input)
  const args: string[] = ['-p', combinePrompt(input), '--output-format', 'stream-json']
  if (input.agent.driverConfig.model?.trim()) {
    args.push('--model', input.agent.driverConfig.model.trim())
  }
  if (readOnly) {
    args.push('--approval-mode', 'plan')
  }
  return args
}

export function parseAcpEventLine(rawLine: string): {
  textDelta?: string
  thinkingDelta?: string
  toolStart?: { id: string; name: string; input?: unknown }
  toolResult?: { id: string; name: string; output?: string; isError?: boolean }
  usage?: TurnUsage
  errorText?: string
  done?: boolean
} | null {
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(rawLine) as Record<string, unknown>
  } catch {
    return null
  }
  const type = String(frame.type || '')
  if (type === 'message' && frame.role === 'assistant' && typeof frame.content === 'string') {
    return { textDelta: frame.content }
  }
  if (type === 'thinking' && typeof frame.content === 'string') {
    return { thinkingDelta: frame.content }
  }
  if (type === 'tool_use') {
    return {
      toolStart: {
        id: String(frame.tool_id || frame.id || `acp-${Date.now()}`),
        name: String(frame.tool_name || frame.name || 'tool'),
        input: frame.parameters ?? frame.input
      }
    }
  }
  if (type === 'tool_result') {
    return {
      toolResult: {
        id: String(frame.tool_id || frame.id || ''),
        name: String(frame.tool_name || frame.name || 'tool'),
        output: typeof frame.output === 'string' ? frame.output : JSON.stringify(frame.output ?? ''),
        isError: frame.status === 'error' || Boolean(frame.is_error)
      }
    }
  }
  if (type === 'error') {
    return { errorText: String(frame.message || frame.error || 'ACP CLI error') }
  }
  if (type === 'result') {
    const stats = (frame.stats ?? frame.usage ?? {}) as {
      input_tokens?: number
      output_tokens?: number
      total_tokens?: number
      duration_ms?: number
    }
    return {
      done: true,
      textDelta: typeof frame.response === 'string' ? frame.response : undefined,
      usage: {
        inputTokens: stats.input_tokens,
        outputTokens: stats.output_tokens,
        durationMs: stats.duration_ms
      }
    }
  }
  return null
}

async function runOneShotStreamCli(opts: {
  daemon: DaemonClient
  prefix: string
  command: string
  args: string[]
  stdinData?: string
  closeStdin?: boolean
  input: TurnInput
  parseLine: (line: string) => ReturnType<typeof parseAcpEventLine>
}): Promise<TurnOutput> {
  if (opts.input.abortSignal.aborted) {
    throw new Error('aborted')
  }
  const daemonProto = opts.daemon.daemonProtocolVersion ?? DAEMON_PROTOCOL_VERSION
  if ((opts.closeStdin || opts.stdinData !== undefined) && daemonProto < 2) {
    throw Errors.driverError(
      `MyAgents daemon (protocol v${daemonProto}) does not support closing stdin for ${opts.command} CLI. Please restart the MyAgents daemon.`
    )
  }

  const startedAt = Date.now()
  const sessionId = `${opts.prefix}-${randomUUID()}`
  const spawnMethod = opts.input.isolation.cleanEnv ? 'spawnPipeClean' : 'spawnPipe'

  return await new Promise<TurnOutput>((resolve, reject) => {
    let settled = false
    let lineBuf = ''
    let stderrBuf = ''
    let textBuf = ''
    let latestUsage: TurnUsage | undefined
    let firstFrame = false

    const cleanup = () => {
      unsub()
      clearTimeout(firstTimer)
      clearTimeout(idleTimer)
      opts.input.abortSignal.removeEventListener('abort', onAbort)
      void opts.daemon.call('release', { sessionId }).catch(() => {})
    }

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        finalText: textBuf.trim() || '(Completed)',
        usage: {
          ...latestUsage,
          durationMs: latestUsage?.durationMs ?? Math.max(0, Date.now() - startedAt)
        }
      })
    }

    const onAbort = () => {
      void opts.daemon.call('kill', { sessionId, force: true }).catch(() => {})
      fail(new Error('aborted'))
    }
    opts.input.abortSignal.addEventListener('abort', onAbort, { once: true })

    const firstTimer = setTimeout(() => {
      if (!firstFrame && !settled) {
        void opts.daemon.call('kill', { sessionId, force: true }).catch(() => {})
        fail(Errors.driverError(`${opts.command} CLI did not produce output within 60s.${stderrBuf ? ` stderr: ${stderrBuf.slice(0, 300)}` : ''}`))
      }
    }, 60_000)

    let idleTimer = setTimeout(() => {}, 300_000)
    const resetIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        void opts.daemon.call('kill', { sessionId, force: true }).catch(() => {})
        fail(Errors.driverError(`${opts.command} CLI idle timeout (300s)`))
      }, 300_000)
    }
    resetIdle()

    const processLine = (line: string) => {
      if (!line || settled) return
      const parsed = opts.parseLine(line)
      if (!parsed) return
      if (parsed.thinkingDelta) {
        opts.input.emit({ kind: 'thinking', delta: parsed.thinkingDelta })
      }
      if (parsed.toolStart) {
        opts.input.emit({ kind: 'tool_start', toolCall: parsed.toolStart })
      }
      if (parsed.toolResult) {
        opts.input.emit({ kind: 'tool_result', toolCall: parsed.toolResult })
      }
      if (parsed.textDelta) {
        textBuf += parsed.textDelta
        opts.input.emit({ kind: 'text', delta: parsed.textDelta })
      }
      if (parsed.usage) {
        latestUsage = parsed.usage
        opts.input.emit({ kind: 'usage', usage: parsed.usage })
      }
      if (parsed.errorText) {
        fail(Errors.driverError(parsed.errorText))
      }
    }

    const unsub = opts.daemon.onEvent((ev: DaemonEvent) => {
      if (ev.sessionId !== sessionId) return
      if (ev.event === 'stderr') {
        stderrBuf += ev.data
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
        return
      }
      if (ev.event === 'data') {
        if (!firstFrame) {
          firstFrame = true
          clearTimeout(firstTimer)
        }
        resetIdle()
        lineBuf += ev.data
        let nl = lineBuf.indexOf('\n')
        while (nl !== -1 && !settled) {
          const line = lineBuf.slice(0, nl).trim()
          lineBuf = lineBuf.slice(nl + 1)
          processLine(line)
          nl = lineBuf.indexOf('\n')
        }
        return
      }
      if (ev.event === 'exit') {
        opts.input.onSessionUpdate({ daemonSessionId: null })
        const tail = lineBuf.trim()
        lineBuf = ''
        if (tail) processLine(tail)
        if (!settled) {
          if (ev.exitCode === 0) succeed()
          else fail(Errors.driverError(`${opts.command} exited with code ${ev.exitCode}${stderrBuf ? `: ${stderrBuf.trim().slice(0, 400)}` : ''}`))
        }
      }
    })

    void opts.daemon
      .call(spawnMethod, {
        sessionId,
        command: opts.command,
        args: opts.args,
        cwd: opts.input.workspace.rootPath,
        env: { ...(opts.input.isolation.envOverrides ?? {}) },
        ...(opts.stdinData !== undefined ? { stdinData: opts.stdinData } : {}),
        ...(opts.closeStdin ? { closeStdin: true } : {})
      })
      .then(() => {
        if (!settled) {
          opts.input.onSessionUpdate({
            daemonSessionId: sessionId,
            configHash: opts.input.configHash,
            lastConsumedOffset: 0
          })
        }
      })
      .catch((err) => {
        fail(err instanceof Error ? err : Errors.driverError(String(err)))
      })
  })
}

export class CodexCliDriver implements AgentDriver {
  readonly kind = 'codex' as const
  readonly capabilities: DriverCapabilities = {
    supportsNativeResume: false,
    supportsSteerWhileRunning: false,
    supportsReadOnlyEnforcement: true,
    supportsDynamicMcp: false,
    supportsSubagentBlock: true
  }

  constructor(private readonly daemon: DaemonClient) {}

  async runTurn(input: TurnInput): Promise<TurnOutput> {
    const command = input.agent.driverConfig.cliPath?.trim() || 'codex'
    return await runOneShotStreamCli({
      daemon: this.daemon,
      prefix: 'codex',
      command,
      args: buildCodexArgs(input),
      stdinData: combinePrompt(input),
      closeStdin: true,
      input,
      parseLine: parseCodexEventLine
    })
  }

  async disposeSession(session: SessionRecord): Promise<void> {
    if (session.daemonSessionId) {
      await this.daemon.call('release', { sessionId: session.daemonSessionId }).catch(() => {})
    }
  }
}

export class AcpCliDriver implements AgentDriver {
  readonly kind = 'acp' as const
  readonly capabilities: DriverCapabilities = {
    supportsNativeResume: false,
    supportsSteerWhileRunning: false,
    supportsReadOnlyEnforcement: true,
    supportsDynamicMcp: false,
    supportsSubagentBlock: true
  }

  constructor(private readonly daemon: DaemonClient) {}

  async runTurn(input: TurnInput): Promise<TurnOutput> {
    const command = input.agent.driverConfig.cliPath?.trim() || 'gemini'
    return await runOneShotStreamCli({
      daemon: this.daemon,
      prefix: 'acp',
      command,
      args: buildAcpArgs(input),
      closeStdin: true,
      input,
      parseLine: parseAcpEventLine
    })
  }

  async disposeSession(session: SessionRecord): Promise<void> {
    if (session.daemonSessionId) {
      await this.daemon.call('release', { sessionId: session.daemonSessionId }).catch(() => {})
    }
  }
}
