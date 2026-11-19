import { randomUUID } from 'node:crypto'
import type { DriverCapabilities, TurnUsage } from '@myagents/protocol'
import type { DaemonEvent } from '@myagents/protocol/node'
import type { DaemonClient } from '../daemon-client'
import { Errors } from '../errors'
import type { AgentDriver, SessionRecord, TurnInput, TurnOutput } from './driver'

function combinePrompt(input: TurnInput): string {
  const parts = [input.agent.systemPrompt?.trim(), input.systemContextPrompt?.trim()].filter(Boolean)
  const prefix = parts.length > 0 ? `[System Context]\n${parts.join('\n\n')}\n\n` : ''
  const readOnly = input.isolation.level !== 'standard' || input.workspaceMode === 'read-only'
  const guard = readOnly
    ? '[Constraint: READ-ONLY workspace access. Do NOT edit files or run mutating commands.]\n\n'
    : ''
  return `${prefix}${guard}${input.instruction}`
}

export function buildCodexArgs(input: TurnInput): string[] {
  const readOnly = input.isolation.level !== 'standard' || input.workspaceMode === 'read-only'
  const args: string[] = ['exec', '--json']
  if (input.agent.driverConfig.model?.trim()) {
    args.push('--model', input.agent.driverConfig.model.trim())
  }
  if (readOnly) {
    args.push('--sandbox', 'read-only')
  } else if (input.agent.permissionMode === 'full') {
    args.push('--full-auto')
  }
  args.push(combinePrompt(input))
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
  }
  if (type === 'turn.completed' && frame.usage && typeof frame.usage === 'object') {
    const u = frame.usage as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
    return {
      usage: {
        inputTokens: u.input_tokens,
        cacheReadTokens: u.cached_input_tokens,
        outputTokens: u.output_tokens,
        contextUsedTokens: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0)
      }
    }
  }
  return null
}

export function buildAcpArgs(input: TurnInput): string[] {
  const readOnly = input.isolation.level !== 'standard' || input.workspaceMode === 'read-only'
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
  input: TurnInput
  parseLine: (line: string) => ReturnType<typeof parseAcpEventLine>
}): Promise<TurnOutput> {
  const startedAt = Date.now()
  const sessionId = `${opts.prefix}-${randomUUID()}`
  const spawnMethod = opts.input.isolation.cleanEnv ? 'spawnPipeClean' : 'spawnPipe'
  await opts.daemon.call(spawnMethod, {
    sessionId,
    command: opts.command,
    args: opts.args,
    cwd: opts.input.workspace.rootPath,
    env: { ...(opts.input.isolation.envOverrides ?? {}) }
  })
  opts.input.onSessionUpdate({
    daemonSessionId: sessionId,
    configHash: opts.input.configHash,
    lastConsumedOffset: 0
  })

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

    const unsub = opts.daemon.onEvent((ev: DaemonEvent) => {
      if (ev.sessionId !== sessionId) return
      if (ev.event === 'stderr') {
        stderrBuf += ev.data
        return
      }
      if (ev.event === 'data') {
        firstFrame = true
        resetIdle()
        lineBuf += ev.data
        let nl = lineBuf.indexOf('\n')
        while (nl !== -1) {
          const line = lineBuf.slice(0, nl).trim()
          lineBuf = lineBuf.slice(nl + 1)
          if (line) {
            const parsed = opts.parseLine(line)
            if (parsed?.thinkingDelta) {
              opts.input.emit({ kind: 'thinking', delta: parsed.thinkingDelta })
            }
            if (parsed?.toolStart) {
              opts.input.emit({ kind: 'tool_start', toolCall: parsed.toolStart })
            }
            if (parsed?.toolResult) {
              opts.input.emit({ kind: 'tool_result', toolCall: parsed.toolResult })
            }
            if (parsed?.textDelta) {
              textBuf += parsed.textDelta
              opts.input.emit({ kind: 'text', delta: parsed.textDelta })
            }
            if (parsed?.usage) {
              latestUsage = parsed.usage
              opts.input.emit({ kind: 'usage', usage: parsed.usage })
            }
            if (parsed?.errorText) {
              fail(Errors.driverError(parsed.errorText))
              return
            }
          }
          nl = lineBuf.indexOf('\n')
        }
        return
      }
      if (ev.event === 'exit') {
        opts.input.onSessionUpdate({ daemonSessionId: null })
        if (!settled) {
          if (ev.exitCode === 0) succeed()
          else fail(Errors.driverError(`${opts.command} exited with code ${ev.exitCode}${stderrBuf ? `: ${stderrBuf.trim().slice(0, 400)}` : ''}`))
        }
      }
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
