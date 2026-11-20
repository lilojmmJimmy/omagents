import { spawn, type ChildProcess } from 'node:child_process'
import { createNdjsonParser, planLaunch } from '@myagents/protocol/node'

export interface ResolvedExternalMcpServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

type PendingRpc = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function parseSseJsonMessages(raw: string): unknown[] {
  const frames: unknown[] = []
  let dataLines: string[] = []
  const flush = () => {
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n').trim()
    dataLines = []
    if (!payload || payload === '[DONE]') return
    try {
      frames.push(JSON.parse(payload))
    } catch {
      // Ignore malformed SSE event payload
    }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flush()
  return frames
}

export class McpClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRpc>()
  private httpSessionId: string | null = null
  private stderrTail = ''
  private closed = false

  constructor(private readonly server: ResolvedExternalMcpServer) {}

  async connect(timeoutMs = 12_000): Promise<void> {
    if (this.closed) throw new Error(`MCP client ${this.server.name} is already closed`)
    if (this.server.transport === 'stdio') {
      await this.spawnStdio()
    }

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'myagents', version: '0.2.0' }
      },
      timeoutMs
    )
    await this.notify('notifications/initialized')
  }

  async listTools(timeoutMs = 12_000): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs)) as {
        tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>
        nextCursor?: unknown
      }
      if (Array.isArray(res?.tools)) {
        for (const t of res.tools) {
          if (typeof t?.name !== 'string' || !t.name) continue
          tools.push({
            name: t.name,
            ...(typeof t.description === 'string' && t.description ? { description: t.description } : {}),
            inputSchema:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? (t.inputSchema as Record<string, unknown>)
                : { type: 'object', properties: {} }
          })
        }
      }
      if (typeof res?.nextCursor === 'string' && res.nextCursor) {
        cursor = res.nextCursor
      } else {
        break
      }
    }
    return tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<{ output: string; isError: boolean }> {
    const res = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as {
      content?: Array<{ type?: unknown; text?: unknown }>
      isError?: unknown
    }
    const parts: string[] = []
    if (Array.isArray(res?.content)) {
      for (const block of res.content) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        } else {
          parts.push(JSON.stringify(block))
        }
      }
    }
    return {
      output: parts.join('\n') || JSON.stringify(res ?? ''),
      isError: Boolean(res?.isError)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.rejectAllPending(new Error(`MCP client ${this.server.name} closed`))

    const child = this.child
    this.child = null
    if (child) {
      try {
        child.stdin?.end()
      } catch {
        // Ignore stream shutdown errors
      }
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
        } else {
          try {
            child.kill('SIGTERM')
          } catch {
            // Already exited
          }
        }
      }
    }
  }

  private async spawnStdio(): Promise<void> {
    const cmd = this.server.command?.trim()
    if (!cmd) throw new Error(`MCP server ${this.server.name} is missing command`)

    const launch = planLaunch(cmd, this.server.args ?? [], process.cwd(), {
      ...process.env,
      ...(this.server.env ?? {})
    })
    const child = spawn(launch.file, launch.args, {
      cwd: process.cwd(),
      env: launch.env,
      stdio: 'pipe',
      windowsHide: true
    })
    this.child = child

    const parse = createNdjsonParser((msg) => this.handleRpcFrame(msg))
    child.stdout?.on('data', parse)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail += chunk
      if (this.stderrTail.length > 4096) this.stderrTail = this.stderrTail.slice(-4096)
    })
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onSpawnErr)
        resolve()
      }
      const onSpawnErr = (err: Error) => {
        child.off('spawn', onSpawn)
        reject(err)
      }
      child.once('spawn', onSpawn)
      child.once('error', onSpawnErr)
    })

    child.on('error', (err) => {
      this.rejectAllPending(new Error(`MCP ${this.server.name} process error: ${err.message}`))
    })
    child.on('close', (code) => {
      this.child = null
      const tail = this.stderrTail.trim()
      this.rejectAllPending(
        new Error(`MCP ${this.server.name} exited with code ${code ?? -1}${tail ? `: ${tail.slice(0, 300)}` : ''}`)
      )
    })
  }

  private handleRpcFrame(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const frame = raw as { id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } }
    if (typeof frame.id !== 'number') return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.error) {
      pending.reject(new Error(String(frame.error.message || `MCP error ${String(frame.error.code ?? '')}`)))
    } else {
      pending.resolve(frame.result)
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.reject(err)
    }
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) throw new Error(`MCP client ${this.server.name} closed`)
    const id = this.nextId++
    const frame = { jsonrpc: '2.0' as const, id, method, params }

    if (this.server.transport === 'http') {
      return await this.sendHttpRequest(frame, timeoutMs)
    }

    const child = this.child
    if (!child || !child.stdin?.writable) {
      throw new Error(`MCP server ${this.server.name} stdio pipe is not writable`)
    }

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${this.server.name} ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin!.write(`${JSON.stringify(frame)}\n`)
    })
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return
    const frame = { jsonrpc: '2.0' as const, method, ...(params ? { params } : {}) }
    if (this.server.transport === 'http') {
      await this.sendHttpNotification(frame)
      return
    }
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`)
    }
  }

  private buildHttpHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.server.headers ?? {}),
      ...(this.httpSessionId ? { 'Mcp-Session-Id': this.httpSessionId } : {})
    }
  }

  private async sendHttpNotification(frame: Record<string, unknown>): Promise<void> {
    const url = this.server.url
    if (!url) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHttpHeaders(),
        body: JSON.stringify(frame),
        signal: controller.signal
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.httpSessionId = sid
    } catch {
      // Notifications are best-effort
    } finally {
      clearTimeout(timer)
    }
  }

  private async sendHttpRequest(frame: { id: number; method: string; params: Record<string, unknown> }, timeoutMs: number): Promise<unknown> {
    const url = this.server.url
    if (!url) throw new Error(`MCP server ${this.server.name} is missing URL`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHttpHeaders(),
        body: JSON.stringify(frame),
        signal: controller.signal
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.httpSessionId = sid
      if (!res.ok) {
        const errBody = (await res.text()).slice(0, 300)
        throw new Error(`HTTP ${res.status}: ${errBody || res.statusText}`)
      }
      const ctype = res.headers.get('content-type') || ''
      const rawText = await res.text()
      const payloads = ctype.includes('text/event-stream')
        ? parseSseJsonMessages(rawText)
        : rawText.trim()
          ? [JSON.parse(rawText)]
          : []
      for (const msg of payloads) {
        if (!msg || typeof msg !== 'object') continue
        const obj = msg as { id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } }
        if (obj.id === frame.id || payloads.length === 1) {
          if (obj.error) {
            throw new Error(String(obj.error.message || `MCP error ${String(obj.error.code ?? '')}`))
          }
          return obj.result
        }
      }
      throw new Error(`Empty MCP response for ${frame.method}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
