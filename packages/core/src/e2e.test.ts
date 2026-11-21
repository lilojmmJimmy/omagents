import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startCoreServer } from './main'

let tmpHome: string
let daemonProc: ChildProcess
let daemonEndpoint: string
let mockLlmServer: http.Server
let mockLlmPort: number

function startMockOpenAiServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-fast-1' }] }))
        return
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> }
          const hasToolResult = body.messages.some((m) => m.role === 'tool')
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          if (!hasToolResult) {
            // First step: issue workspace_write tool call
            const chunk = {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_write_1',
                        type: 'function',
                        function: {
                          name: 'workspace_write',
                          arguments: JSON.stringify({ path: 'notes/e2e.txt', content: 'hello from builtin agent' })
                        }
                      }
                    ]
                  }
                }
              ]
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          } else {
            // Second step: return final text answer
            const c1 = { choices: [{ delta: { content: 'Done! Wrote ' } }] }
            const c2 = {
              choices: [{ delta: { content: 'notes/e2e.txt.' } }],
              usage: { prompt_tokens: 42, completion_tokens: 12 }
            }
            res.write(`data: ${JSON.stringify(c1)}\n\n`)
            res.write(`data: ${JSON.stringify(c2)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          }
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, port: addr.port })
    })
  })
}

async function rpcCall(ws: WebSocket, id: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return await new Promise((resolve, reject) => {
    const onMsg = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString('utf8'))
      if (parsed.id !== id) return
      ws.off('message', onMsg)
      if (parsed.error)
        reject(
          Object.assign(new Error(parsed.error.message), { code: parsed.error.code, reason: parsed.error.data?.reason })
        )
      else resolve(parsed.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

beforeAll(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-e2e-'))
  process.env.MYAGENTS_HOME = tmpHome
  daemonEndpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\myagents-test-${Date.now()}` : path.join(tmpHome, 'daemon.sock')

  const here = path.dirname(fileURLToPath(import.meta.url))
  const daemonEntry = path.resolve(here, '../../daemon/src/main.ts')
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

  const mock = await startMockOpenAiServer()
  mockLlmServer = mock.server
  mockLlmPort = mock.port
}, 20_000)

afterAll(() => {
  daemonProc?.kill()
  mockLlmServer?.close()
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // Windows file handles may linger briefly
  }
})

describe('MyAgents v0.1a End-to-End Acceptance', () => {
  it('verifies login, builtin agent tool execution, file optimistic lock, envCheck, and core hot-restart preserving daemon PTY', async () => {
    const dbPath = path.join(tmpHome, 'data', 'myagents.db')
    const port1 = 33410 + Math.floor(Math.random() * 1000)
    const core1 = await startCoreServer({
      host: '127.0.0.1',
      port: port1,
      dbPath,
      daemonEndpoint,
      autoStartDaemon: false
    })

    // 1. Auth login (admin/admin) + wrong password rejected
    const badLogin = await fetch(`http://127.0.0.1:${port1}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' })
    })
    expect(badLogin.status).toBe(401)

    const loginRes = await fetch(`http://127.0.0.1:${port1}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    })
    expect(loginRes.status).toBe(200)
    const loginData = (await loginRes.json()) as { token: string; username: string }
    expect(loginData.username).toBe('admin')

    // Reject cross-origin WS
    await new Promise<void>((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${port1}/rpc`, {
        headers: { Authorization: `Bearer ${loginData.token}`, Origin: 'https://evil.example.com' }
      })
      badWs.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(403)
        resolve()
      })
    })

    // Connect authenticated WS
    const ws = new WebSocket(`ws://127.0.0.1:${port1}/rpc`, {
      headers: { Authorization: `Bearer ${loginData.token}` }
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    // 2. EnvCheck detects git & claude
    const env = await rpcCall(ws, '1', 'system.envCheck', { refresh: true })
    expect(env.git.installed).toBe(true)

    // 3. Configure mock OpenAI provider + Builtin Agent + Single Room
    const provider = await rpcCall(ws, '2', 'providers.save', {
      name: 'MockLLM',
      kind: 'openai-compat',
      baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
      apiKey: 'sk-test-123456',
      defaultModel: 'mock-fast-1',
      models: ['mock-fast-1']
    })
    const probe = await rpcCall(ws, '3', 'providers.probe', { id: provider.id })
    expect(probe.ok).toBe(true)

    const agent = await rpcCall(ws, '4', 'agents.create', {
      name: 'LightBot',
      driverKind: 'builtin',
      providerId: provider.id,
      permissionMode: 'workspace-write'
    })
    expect(agent.defaultWorkspacePath).toBeTruthy()

    const room = await rpcCall(ws, '5', 'rooms.create', {
      strategyId: 'single',
      members: [{ agentId: agent.id }]
    })

    // Wait for agent completion message
    const completionPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timeout')), 10_000)
      const onMsg = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.messageCreated' && parsed.params.authorKind === 'agent') {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params)
        }
      }
      ws.on('message', onMsg)
    })

    await rpcCall(ws, '6', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Write a hello note in notes/e2e.txt',
      idempotencyKey: 'e2e-msg-1'
    })

    const replyMsg = await completionPromise
    expect(replyMsg.content).toContain('Done! Wrote notes/e2e.txt.')

    // Verify file created in private workspace + optimistic lock check
    const diskContent = readFileSync(path.join(agent.defaultWorkspacePath, 'notes', 'e2e.txt'), 'utf8')
    expect(diskContent).toBe('hello from builtin agent')

    const readRes = await rpcCall(ws, '7', 'files.read', {
      workspaceId: agent.defaultWorkspaceId,
      path: 'notes/e2e.txt'
    })
    expect(readRes.content).toBe('hello from builtin agent')
    await expect(
      rpcCall(ws, '8', 'files.write', {
        workspaceId: agent.defaultWorkspaceId,
        path: 'notes/e2e.txt',
        content: 'stale edit',
        expectedMtimeMs: readRes.mtimeMs - 5000
      })
    ).rejects.toMatchObject({ reason: 'mtime_conflict' })

    // Verify tool events persisted
    const events = await rpcCall(ws, '9', 'workNodes.events', { nodeId: replyMsg.workNodeId })
    expect(events.some((e: any) => e.kind === 'tool_start')).toBe(true)
    expect(events.some((e: any) => e.kind === 'tool_result')).toBe(true)

    // 4. Open PTY terminal in daemon, write marker, wait for output, then HOT-RESTART core!
    const term = await rpcCall(ws, '10', 'terminal.open', { workspaceId: agent.defaultWorkspaceId, cols: 80, rows: 24 })
    await new Promise<void>((resolve, reject) => {
      let seen = ''
      const timer = setTimeout(() => {
        unsub()
        reject(new Error(`PTY marker timeout; saw: ${seen.slice(0, 200)}`))
      }, 10_000)
      const unsub = core1.terminals.subscribe(term.id, (ev) => {
        if (ev.event === 'data') {
          seen += ev.data
          if (seen.includes('HOT_RESTART_OK_MARKER')) {
            clearTimeout(timer)
            unsub()
            resolve()
          }
        }
      })
      void core1.terminals.write(term.id, 'echo HOT_RESTART_OK_MARKER\r')
    })

    ws.close()
    await core1.stop()

    // Restart core2 pointing to the SAME DB and SAME live daemon!
    const port2 = port1 + 1
    const core2 = await startCoreServer({
      host: '127.0.0.1',
      port: port2,
      dbPath,
      daemonEndpoint,
      autoStartDaemon: false
    })

    // Session cookie/token survived core restart!
    const meAfterRestart = await fetch(`http://127.0.0.1:${port2}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginData.token}` }
    })
    const meJson = (await meAfterRestart.json()) as { authenticated: boolean; username: string }
    expect(meJson.authenticated).toBe(true)

    // Terminal survived core restart & still has scrollback buffer!
    const attachAfter = await core2.terminals.attach(term.id)
    expect(attachAfter.exited).toBe(false)
    expect(attachAfter.buffer).toContain('HOT_RESTART_OK_MARKER')

    await core2.terminals.close(term.id)
    await core2.stop()
  }, 30_000)
})
