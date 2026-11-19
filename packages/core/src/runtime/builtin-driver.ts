import { randomUUID } from 'node:crypto'
import type { ApprovalGate, CollabToolName, DriverCapabilities, Redactor } from '@myagents/protocol'
import type { DaemonClient } from '../daemon-client'
import { Errors } from '../errors'
import collabToolsSpec from '../mcp/collab-tools.json'
import type { GitService } from '../workspace/git-service'
import type { WorkspaceService } from '../workspace/workspace-service'
import type { AgentDriver, TurnInput, TurnOutput } from './driver'
import type { ProviderService } from './provider-service'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

interface OpenAiToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const READ_TOOLS: OpenAiToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'workspace_list',
      description: 'List files and directories inside the current workspace.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Relative directory path (empty for workspace root).' },
          maxDepth: { type: 'integer', minimum: 1, maximum: 4, description: 'Directory depth (default 2).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_read',
      description: 'Read a text file inside the current workspace with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path inside workspace.' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_grep',
      description: 'Search text pattern (case-insensitive regex) across workspace files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          dir: { type: 'string' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_git_diff',
      description: 'Inspect git status and diff of the current workspace if it is a git repository.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }
]

const WRITE_TOOLS: OpenAiToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'workspace_write',
      description: 'Create or overwrite a text file inside the current workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_patch',
      description: 'Replace an exact substring in a text file inside the current workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'workspace_exec',
      description: 'Run an executable directly (no shell) inside the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Executable name, e.g. node, git, pnpm, python.' },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 }
        },
        required: ['command']
      }
    }
  }
]

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('aborted')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class BuiltinDriver implements AgentDriver {
  readonly kind = 'builtin' as const
  readonly capabilities: DriverCapabilities = {
    supportsNativeResume: false,
    supportsSteerWhileRunning: false,
    supportsReadOnlyEnforcement: true,
    supportsDynamicMcp: true,
    supportsSubagentBlock: true
  }

  constructor(
    private readonly providers: ProviderService,
    private readonly workspaces: WorkspaceService,
    private readonly git: GitService,
    private readonly daemon: DaemonClient,
    private readonly approvalGate: ApprovalGate,
    private readonly redactor: Redactor
  ) {}

  async runTurn(input: TurnInput): Promise<TurnOutput> {
    const startedAt = Date.now()
    if (!input.agent.providerId) {
      throw Errors.driverError('Builtin agent has no model provider configured')
    }
    const { provider, apiKey } = await this.providers.resolveCredentials(input.agent.providerId)
    if (apiKey) this.redactor.registerSecret(apiKey)

    const model = input.agent.driverConfig.model || provider.defaultModel
    const maxSteps = input.agent.driverConfig.maxSteps ?? 25
    const readOnly = input.isolation.level !== 'standard' || input.workspaceMode === 'read-only'
    const baseTools = input.isolation.level === 'lockdown' ? [] : readOnly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS]
    const collabTools: OpenAiToolDef[] =
      input.allowedCollabTools && input.callCollabTool
        ? collabToolsSpec
            .filter((t) => input.allowedCollabTools!.includes(t.name as CollabToolName))
            .map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema
              }
            }))
        : []
    const tools = [...baseTools, ...collabTools]

    const sysParts = [
      input.agent.systemPrompt?.trim() || `You are ${input.agent.name}, a helpful and concise AI agent.`,
      `Workspace directory: ${input.workspace.rootPath} (mode: ${readOnly ? 'READ-ONLY' : 'READ-WRITE'}).`,
      input.isolation.level === 'lockdown'
        ? 'You are running in strict lockdown mode. Workspace tools are disabled.'
        : readOnly
          ? 'You may inspect files using workspace_* read tools, but you must not modify files.'
          : 'You may read, write, patch files, and run commands inside your workspace using workspace_* tools.'
    ]
    if (input.systemContextPrompt?.trim()) {
      sysParts.push(input.systemContextPrompt.trim())
    }

    const messages: ChatMessage[] = [{ role: 'system', content: sysParts.join('\n\n') }]
    // Include recent conversation history (bounded to last 30 messages)
    for (const msg of input.historyMessages.slice(-30)) {
      if (msg.authorKind === 'human' || msg.authorKind === 'intake') {
        messages.push({ role: 'user', content: msg.content })
      } else if (msg.authorKind === 'agent') {
        messages.push({ role: 'assistant', content: msg.content })
      }
    }
    // Ensure current instruction is the final user turn if not already last
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== input.instruction) {
      messages.push({ role: 'user', content: input.instruction })
    }

    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalThinkingTokens = 0
    let latestContextUsed: number | undefined
    let firstOutputAt: number | null = null
    let stepsRun = 0
    let finalText = ''

    const buildUsage = () => {
      const now = Date.now()
      const durationMs = Math.max(0, now - startedAt)
      const genMs = firstOutputAt ? Math.max(100, now - firstOutputAt) : durationMs
      const tokensPerSec =
        totalOutputTokens > 0 && genMs > 0
          ? Number((totalOutputTokens / (genMs / 1000)).toFixed(1))
          : undefined
      return {
        model,
        inputTokens: totalInputTokens || undefined,
        outputTokens: totalOutputTokens || undefined,
        cacheReadTokens: totalCacheReadTokens || undefined,
        thinkingTokens: totalThinkingTokens || undefined,
        contextUsedTokens: latestContextUsed,
        durationMs,
        ttftMs: firstOutputAt ? Math.max(0, firstOutputAt - startedAt) : undefined,
        tokensPerSec,
        numTurns: stepsRun || undefined
      }
    }

    for (let step = 1; step <= maxSteps; step++) {
      if (input.abortSignal.aborted) throw new Error('aborted')
      stepsRun = step

      const allowTools = step < maxSteps
      const stepRes = await this.callOpenAiStream({
        baseUrl: provider.baseUrl,
        apiKey,
        model,
        temperature: input.agent.driverConfig.temperature,
        messages,
        tools: allowTools ? tools : undefined,
        signal: input.abortSignal,
        onTextDelta: (delta) => {
          firstOutputAt ??= Date.now()
          input.emit({ kind: 'text', delta })
        },
        onThinkingDelta: (delta) => {
          firstOutputAt ??= Date.now()
          input.emit({ kind: 'thinking', delta })
        }
      })

      totalInputTokens += stepRes.inputTokens
      totalOutputTokens += stepRes.outputTokens
      totalCacheReadTokens += stepRes.cacheReadTokens
      totalThinkingTokens += stepRes.thinkingTokens
      if (stepRes.inputTokens > 0) latestContextUsed = stepRes.inputTokens
      input.emit({ kind: 'usage', usage: buildUsage() })

      if (stepRes.toolCalls.length === 0) {
        finalText = stepRes.text
        break
      }

      messages.push({
        role: 'assistant',
        content: stepRes.text || null,
        tool_calls: stepRes.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsText }
        }))
      })

      for (const tc of stepRes.toolCalls) {
        if (input.abortSignal.aborted) throw new Error('aborted')
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = tc.argumentsText ? (JSON.parse(tc.argumentsText) as Record<string, unknown>) : {}
        } catch {
          parsedArgs = { _raw: tc.argumentsText }
        }

        input.emit({
          kind: 'tool_start',
          toolCall: { id: tc.id, name: tc.name, input: parsedArgs }
        })

        const gate = await this.approvalGate.checkToolCall({
          roomId: input.roomId,
          workNodeId: input.workNodeId,
          agentId: input.agent.id,
          toolName: tc.name,
          args: parsedArgs
        })

        let output = ''
        let isError = false
        if (gate.decision !== 'allow') {
          isError = true
          output = `Tool blocked by policy: ${gate.reason || gate.decision}`
        } else if (tc.name.startsWith('collab_') && input.callCollabTool && input.allowedCollabTools?.includes(tc.name as CollabToolName)) {
          try {
            const res = await input.callCollabTool(tc.name as CollabToolName, parsedArgs, tc.id)
            output = res.output
            isError = Boolean(res.isError || !res.ok)
          } catch (err) {
            isError = true
            output = `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        } else if (input.isolation.level === 'lockdown') {
          isError = true
          output = 'Tool blocked in lockdown isolation mode.'
        } else {
          try {
            output = await this.executeWorkspaceTool(tc.name, parsedArgs, input, readOnly)
          } catch (err) {
            isError = true
            output = `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        const safeOut = this.redactor.scrub(output).slice(0, 32_000)
        input.emit({
          kind: 'tool_result',
          toolCall: { id: tc.id, name: tc.name, output: safeOut, isError }
        })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: safeOut })
      }

      if (step === maxSteps - 1) {
        messages.push({
          role: 'user',
          content: '[System] You have reached the tool step budget. Summarize your findings and final answer now without calling more tools.'
        })
      }
    }

    return {
      finalText: finalText || '(Completed without text response)',
      usage: buildUsage()
    }
  }

  private async executeWorkspaceTool(
    name: string,
    args: Record<string, unknown>,
    input: TurnInput,
    readOnly: boolean
  ): Promise<string> {
    const wsId = input.workspace.id
    switch (name) {
      case 'workspace_list': {
        const dir = typeof args.dir === 'string' ? args.dir : ''
        const maxDepth = typeof args.maxDepth === 'number' ? Math.min(4, Math.max(1, args.maxDepth)) : 2
        const entries = this.workspaces.listTree(wsId, dir, maxDepth)
        if (entries.length === 0) return '(empty directory)'
        return entries.map((e) => `${e.kind === 'dir' ? '[DIR] ' : '      '}${e.path}`).join('\n')
      }
      case 'workspace_read': {
        const filePath = String(args.path ?? '')
        const res = this.workspaces.readFile(wsId, filePath)
        if (res.binary) return `(binary file: ${res.size} bytes)`
        const lines = res.content.split(/\r?\n/)
        const start = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1
        const end = typeof args.endLine === 'number' ? Math.min(lines.length, args.endLine) : lines.length
        const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n')
        return slice.slice(0, 40_000)
      }
      case 'workspace_grep': {
        const pattern = String(args.pattern ?? '')
        const dir = typeof args.dir === 'string' ? args.dir : ''
        const hits = this.workspaces.grep(wsId, pattern, dir, 50)
        if (hits.length === 0) return '(no matches)'
        return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
      }
      case 'workspace_git_diff': {
        const p = typeof args.path === 'string' ? args.path : undefined
        const diffs = await this.git.diff(input.workspace.rootPath, p)
        if (diffs.length === 0) return '(no git changes)'
        return diffs.map((d) => `=== ${d.path} (${d.status}, +${d.additions}/-${d.deletions}) ===\n${d.patch}`).join('\n\n')
      }
      case 'workspace_write': {
        if (readOnly) throw new Error('Workspace is read-only')
        const filePath = String(args.path ?? '')
        const content = String(args.content ?? '')
        const res = this.workspaces.writeFile(wsId, filePath, content)
        return `Wrote ${filePath} (${content.length} chars, mtime=${res.mtimeMs})`
      }
      case 'workspace_patch': {
        if (readOnly) throw new Error('Workspace is read-only')
        const filePath = String(args.path ?? '')
        const oldText = String(args.oldText ?? '')
        const newText = String(args.newText ?? '')
        const current = this.workspaces.readFile(wsId, filePath)
        if (current.binary) throw new Error('Cannot patch binary file')
        if (!current.content.includes(oldText)) throw new Error('oldText not found in file')
        const updated = current.content.replace(oldText, newText)
        this.workspaces.writeFile(wsId, filePath, updated, current.mtimeMs)
        return `Patched ${filePath} successfully`
      }
      case 'workspace_exec': {
        if (readOnly) throw new Error('Workspace is read-only')
        const command = String(args.command ?? '')
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : []
        const timeoutMs = typeof args.timeoutMs === 'number' ? Math.min(60_000, Math.max(1000, args.timeoutMs)) : 20_000
        return await this.runCommandViaDaemon(command, cmdArgs, input.workspace.rootPath, timeoutMs, input.abortSignal)
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  private async runCommandViaDaemon(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<string> {
    const sessionId = `exec-${randomUUID()}`
    let stdout = ''
    let stderr = ''

    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        unsub()
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        void this.daemon.call('release', { sessionId }).catch(() => {})
      }
      const finish = (code: number) => {
        if (settled) return
        settled = true
        cleanup()
        const combined = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : ''].filter(Boolean).join('\n')
        resolve(`exitCode=${code}\n${combined.slice(0, 24_000)}`)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('aborted'))
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve(`Command timed out after ${timeoutMs}ms.\n${stdout.slice(0, 8000)}`)
      }, timeoutMs)

      const unsub = this.daemon.onEvent((ev) => {
        if (ev.sessionId !== sessionId) return
        if (ev.event === 'data') stdout += ev.data
        else if (ev.event === 'stderr') stderr += ev.data
        else if (ev.event === 'exit') finish(ev.exitCode)
      })

      signal.addEventListener('abort', onAbort, { once: true })

      this.daemon
        .call('spawnPipeClean', { sessionId, command, args, cwd, env: {} })
        .catch((err) => {
          if (settled) return
          settled = true
          cleanup()
          reject(err)
        })
    })
  }

  private async callOpenAiStream(opts: {
    baseUrl: string
    apiKey: string | null
    model: string
    temperature?: number
    messages: ChatMessage[]
    tools?: OpenAiToolDef[]
    signal: AbortSignal
    onTextDelta: (delta: string) => void
    onThinkingDelta: (delta: string) => void
  }): Promise<{
    text: string
    toolCalls: Array<{ id: string; name: string; argumentsText: string }>
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    thinkingTokens: number
  }> {
    const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

    let includeStreamOptions = true
    const buildBody = () => {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: opts.messages,
        stream: true
      }
      if (includeStreamOptions) body.stream_options = { include_usage: true }
      if (opts.temperature !== undefined) body.temperature = opts.temperature
      if (opts.tools && opts.tools.length > 0) body.tools = opts.tools
      return body
    }

    // Bounded network retry (only in LLM client, never duplicated in scheduler)
    let res: Response | null = null
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildBody()),
          signal: opts.signal
        })
        if (res.ok) break
        const errBody = await res.text()
        if (res.status === 400 && includeStreamOptions && /stream_options|include_usage/i.test(errBody)) {
          includeStreamOptions = false
          continue
        }
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`)
          await sleep(1000 * 2 ** attempt, opts.signal)
          continue
        }
        throw Errors.driverError(`LLM API error HTTP ${res.status}: ${errBody.slice(0, 400)}`)
      } catch (err) {
        if (opts.signal.aborted) throw new Error('aborted')
        if (err instanceof Error && err.name === 'AppError') throw err
        lastErr = err instanceof Error ? err : new Error(String(err))
        if (attempt < 2) await sleep(1000 * 2 ** attempt, opts.signal)
      }
    }

    if (!res || !res.ok) {
      throw Errors.driverError(lastErr?.message || 'LLM API request failed')
    }
    if (!res.body) {
      throw Errors.driverError('LLM API returned empty response body')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let thinkingTokens = 0
    const toolMap = new Map<number, { id: string; name: string; argumentsText: string }>()

    // Streaming <think>...</think> tag extractor for reasoning models that embed CoT in content
    let inThinkTag = false
    let tagBuf = ''
    const emitContentChunk = (raw: string) => {
      tagBuf += raw
      while (tagBuf.length > 0) {
        if (!inThinkTag) {
          const openIdx = tagBuf.indexOf('<think>')
          if (openIdx !== -1) {
            const before = tagBuf.slice(0, openIdx)
            if (before) {
              text += before
              opts.onTextDelta(before)
            }
            tagBuf = tagBuf.slice(openIdx + 7)
            inThinkTag = true
            continue
          }
          // Hold back a potential partial '<think>' prefix at the tail
          const partial = tagBuf.lastIndexOf('<')
          if (partial !== -1 && '<think>'.startsWith(tagBuf.slice(partial))) {
            const safe = tagBuf.slice(0, partial)
            if (safe) {
              text += safe
              opts.onTextDelta(safe)
            }
            tagBuf = tagBuf.slice(partial)
            break
          }
          text += tagBuf
          opts.onTextDelta(tagBuf)
          tagBuf = ''
        } else {
          const closeIdx = tagBuf.indexOf('</think>')
          if (closeIdx !== -1) {
            const thought = tagBuf.slice(0, closeIdx)
            if (thought) opts.onThinkingDelta(thought)
            tagBuf = tagBuf.slice(closeIdx + 8)
            inThinkTag = false
            continue
          }
          const partial = tagBuf.lastIndexOf('<')
          if (partial !== -1 && '</think>'.startsWith(tagBuf.slice(partial))) {
            const safe = tagBuf.slice(0, partial)
            if (safe) opts.onThinkingDelta(safe)
            tagBuf = tagBuf.slice(partial)
            break
          }
          opts.onThinkingDelta(tagBuf)
          tagBuf = ''
        }
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let idx = pending.indexOf('\n')
      while (idx !== -1) {
        const line = pending.slice(0, idx).trim()
        pending = pending.slice(idx + 1)
        idx = pending.indexOf('\n')

        if (!line || !line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null
              reasoning_content?: string | null
              reasoning?: string | null
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
          }
        }
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens
          outputTokens = chunk.usage.completion_tokens ?? outputTokens
          cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cacheReadTokens
          thinkingTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? thinkingTokens
        }
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        const reasoningDelta =
          (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
          (typeof delta.reasoning === 'string' && delta.reasoning) ||
          ''
        if (reasoningDelta) {
          opts.onThinkingDelta(reasoningDelta)
        }
        if (typeof delta.content === 'string' && delta.content) {
          emitContentChunk(delta.content)
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const cur = toolMap.get(tc.index) ?? { id: tc.id || `call_${tc.index}_${Date.now()}`, name: '', argumentsText: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.argumentsText += tc.function.arguments
            toolMap.set(tc.index, cur)
          }
        }
      }
    }

    // Flush any remaining buffered text outside tags
    if (tagBuf) {
      if (inThinkTag) {
        opts.onThinkingDelta(tagBuf)
      } else {
        text += tagBuf
        opts.onTextDelta(tagBuf)
      }
      tagBuf = ''
    }

    const toolCalls = [...toolMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.name)

    return { text, toolCalls, inputTokens, outputTokens, cacheReadTokens, thinkingTokens }
  }
}
