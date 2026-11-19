import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startCoreServer } from './main'

let tmpHome: string
let gitRepoDir: string
let daemonProc: ChildProcess
let daemonEndpoint: string
let mockLlmServer: http.Server
let mockLlmPort: number
let llmStepMode: 'multi-tool' | 'slow-abort' | 'fail-once' = 'multi-tool'
let failOnceConsumed = false

function startMockLlm(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-tool-1' }] }))
        return
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string; tool_call_id?: string }> }

          if (llmStepMode === 'fail-once' && !failOnceConsumed) {
            failOnceConsumed = true
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Simulated provider error' } }))
            return
          }

          if (llmStepMode === 'slow-abort') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Starting slow work...' } }] })}\n\n`)
            const timer = setTimeout(() => {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' finished.' } }] })}\n\n`)
              res.write('data: [DONE]\n\n')
              res.end()
            }, 15_000)
            req.on('close', () => clearTimeout(timer))
            return
          }

          const toolMessages = body.messages.filter((m) => m.role === 'tool')
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })

          if (toolMessages.length === 0) {
            // Step 1: write + patch + list + grep + git_diff + exec in one multi-tool batch
            const calls = [
              {
                index: 0,
                id: 'tc_write',
                type: 'function',
                function: { name: 'workspace_write', arguments: JSON.stringify({ path: 'app.txt', content: 'hello world\nline two\n' }) }
              },
              {
                index: 1,
                id: 'tc_patch',
                type: 'function',
                function: { name: 'workspace_patch', arguments: JSON.stringify({ path: 'app.txt', oldText: 'world', newText: 'myagents' }) }
              },
              {
                index: 2,
                id: 'tc_read',
                type: 'function',
                function: { name: 'workspace_read', arguments: JSON.stringify({ path: 'app.txt' }) }
              },
              {
                index: 3,
                id: 'tc_grep',
                type: 'function',
                function: { name: 'workspace_grep', arguments: JSON.stringify({ pattern: 'myagents' }) }
              },
              {
                index: 4,
                id: 'tc_list',
                type: 'function',
                function: { name: 'workspace_list', arguments: JSON.stringify({ maxDepth: 2 }) }
              },
              {
                index: 5,
                id: 'tc_diff',
                type: 'function',
                function: { name: 'workspace_git_diff', arguments: JSON.stringify({}) }
              },
              {
                index: 6,
                id: 'tc_exec',
                type: 'function',
                function: { name: 'workspace_exec', arguments: JSON.stringify({ command: 'node', args: ['-e', 'console.log(21*2)'] }) }
              }
            ]
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Planning workspace tools...' } }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          } else {
            const summary = `All ${toolMessages.length} tools completed. Exec output: ${toolMessages[toolMessages.length - 1]?.content?.trim()}`
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '<think>Verifying tool outputs.</think>' } }] })}\n\n`)
            res.write(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: summary } }],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 30,
                  completion_tokens_details: { reasoning_tokens: 12 }
                }
              })}\n\n`
            )
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
      if (parsed.error) reject(Object.assign(new Error(parsed.error.message), { code: parsed.error.code, reason: parsed.error.data?.reason }))
      else resolve(parsed.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

beforeAll(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-acc-'))
  gitRepoDir = path.join(tmpHome, 'sample-git-repo')
  process.env.MYAGENTS_HOME = tmpHome
  daemonEndpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\myagents-acc-${Date.now()}`
      : path.join(tmpHome, 'daemon.sock')

  // Create a real local git repository for Git Diff & Project Workspace tests
  execFileSync('git', ['init', gitRepoDir], { windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'test@myagents.local'], { cwd: gitRepoDir, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir, windowsHide: true })
  writeFileSync(path.join(gitRepoDir, 'app.txt'), 'initial\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: gitRepoDir, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: gitRepoDir, windowsHide: true })

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
  })

  const mock = await startMockLlm()
  mockLlmServer = mock.server
  mockLlmPort = mock.port
}, 20_000)

afterAll(() => {
  daemonProc?.kill()
  mockLlmServer?.close()
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('MyAgents v0.1a Extended Acceptance (All Tools, Upload/Download, Git Diff, Stop/Retry, Terminal WS)', () => {
  it('verifies all 7 workspace tools, HTTP file upload/download, Git diff, idempotency, Stop/Retry, password change, and /ws/terminal', async () => {
    const dbPath = path.join(tmpHome, 'data', 'myagents.db')
    const port = 34510 + Math.floor(Math.random() * 1000)
    const core = await startCoreServer({
      host: '127.0.0.1',
      port,
      dbPath,
      daemonEndpoint,
      autoStartDaemon: false
    })

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    })
    const { token } = (await loginRes.json()) as { token: string }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Authorization: `Bearer ${token}` } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    // 1. Register local Git project + test mkdir / upload / download / rename / remove
    const proj = await rpcCall(ws, 'p1', 'workspaces.registerProject', { name: 'SampleRepo', rootPath: gitRepoDir })
    expect(proj.isGit).toBe(true)

    await rpcCall(ws, 'f1', 'files.mkdir', { workspaceId: proj.id, path: 'docs' })
    const form = new FormData()
    form.append('file', new Blob(['uploaded-hello-123'], { type: 'text/plain' }), 'upload.txt')
    const upRes = await fetch(`http://127.0.0.1:${port}/api/workspaces/${proj.id}/upload?dir=docs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    })
    expect(upRes.status).toBe(200)
    const upJson = (await upRes.json()) as { path: string; size: number }
    expect(upJson.path).toBe('docs/upload.txt')

    const dlRes = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${proj.id}/download?path=${encodeURIComponent('docs/upload.txt')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    expect(dlRes.status).toBe(200)
    expect(await dlRes.text()).toBe('uploaded-hello-123')

    await rpcCall(ws, 'f2', 'files.rename', { workspaceId: proj.id, path: 'docs/upload.txt', newPath: 'docs/renamed.txt' })
    await rpcCall(ws, 'f3', 'files.remove', { workspaceId: proj.id, path: 'docs/renamed.txt' })

    // 2. Builtin Agent executes ALL 7 workspace_* tools against Git project
    const provider = await rpcCall(ws, 'pr1', 'providers.save', {
      name: 'MockTools',
      kind: 'openai-compat',
      baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
      apiKey: 'sk-test-tools',
      defaultModel: 'mock-tool-1',
      models: ['mock-tool-1']
    })
    const agent = await rpcCall(ws, 'a1', 'agents.create', {
      name: 'ToolRunner',
      driverKind: 'builtin',
      providerId: provider.id,
      permissionMode: 'workspace-write'
    })
    const room = await rpcCall(ws, 'r1', 'rooms.create', {
      strategyId: 'single',
      primaryWorkspaceId: proj.id,
      members: [{ agentId: agent.id }]
    })

    const waitNextAgentOrSystem = (expectedAuthor: 'agent' | 'system') =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting ${expectedAuthor}`)), 15_000)
        const onMsg = (raw: WebSocket.RawData) => {
          const parsed = JSON.parse(raw.toString('utf8'))
          if (parsed.method === 'room.messageCreated' && parsed.params.authorKind === expectedAuthor) {
            clearTimeout(timer)
            ws.off('message', onMsg)
            resolve(parsed.params)
          }
        }
        ws.on('message', onMsg)
      })

    llmStepMode = 'multi-tool'
    const done1 = waitNextAgentOrSystem('agent')
    const sent1 = await rpcCall(ws, 'm1', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Run all 7 workspace tools',
      idempotencyKey: 'idem-1'
    })
    // Duplicate idempotencyKey returns identical message without creating a 2nd turn
    const sent1Dup = await rpcCall(ws, 'm1d', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Run all 7 workspace tools',
      idempotencyKey: 'idem-1'
    })
    expect(sent1Dup.message.id).toBe(sent1.message.id)

    // Verify DB-backed builtin agent does NOT expose a JSONL sessionFilePath
    expect(room.members[0]?.sessionFilePath ?? null).toBeNull()

    const reply1 = await done1
    expect(reply1.content).toContain('All 7 tools completed')
    expect(reply1.content).toContain('42')
    expect(reply1.content).not.toContain('<think>')
    expect(reply1.meta?.usage?.model).toBe('mock-tool-1')
    expect(reply1.meta?.usage?.contextUsedTokens).toBe(100)
    expect(reply1.meta?.usage?.outputTokens).toBe(30)
    expect(reply1.meta?.usage?.thinkingTokens).toBe(12)
    expect(reply1.meta?.usage?.tokensPerSec).toBeGreaterThan(0)
    expect(typeof reply1.meta?.usage?.durationMs).toBe('number')
    expect(readFileSync(path.join(gitRepoDir, 'app.txt'), 'utf8')).toContain('hello myagents')

    // Verify CoT thinking events persisted in node_events
    const nodeEvents = await rpcCall(ws, 'ne1', 'workNodes.events', { nodeId: reply1.workNodeId })
    const thinkingTexts = nodeEvents
      .filter((e: any) => e.kind === 'thinking')
      .map((e: any) => String(e.payload?.text ?? ''))
      .join('\n')
    expect(thinkingTexts).toContain('Planning workspace tools')
    expect(thinkingTexts).toContain('Verifying tool outputs')

    // Verify Git status & Git diff reflect the agent's change
    const gitStatus = await rpcCall(ws, 'g1', 'git.status', { workspaceId: proj.id })
    expect(gitStatus.files.some((f: any) => f.path === 'app.txt')).toBe(true)
    const gitDiff = await rpcCall(ws, 'g2', 'git.diff', { workspaceId: proj.id })
    expect(gitDiff.files[0].patch).toContain('+hello myagents')

    // 3. Test Fail -> Retry flow
    llmStepMode = 'fail-once'
    failOnceConsumed = false
    const failNotice = waitNextAgentOrSystem('system')
    await rpcCall(ws, 'm2', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Trigger simulated error then retry',
      idempotencyKey: 'idem-2'
    })
    const sysMsg = await failNotice
    expect(sysMsg.content).toContain('Simulated provider error')

    llmStepMode = 'multi-tool'
    const retryDone = waitNextAgentOrSystem('agent')
    const retriedNode = await rpcCall(ws, 'c1', 'workNodes.control', { nodeId: sysMsg.workNodeId, action: 'retry' })
    expect(retriedNode.attempt).toBe(2)
    await retryDone

    // 4. Test Stop (abort mid-stream)
    llmStepMode = 'slow-abort'
    const runningPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting streamDelta')), 8000)
      const onMsg = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.streamDelta' && parsed.params.kind === 'text') {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params.workNodeId)
        }
      }
      ws.on('message', onMsg)
    })
    await rpcCall(ws, 'm3', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Start slow streaming task',
      idempotencyKey: 'idem-3'
    })
    const slowNodeId = await runningPromise
    const stopped = await rpcCall(ws, 'c2', 'workNodes.control', { nodeId: slowNodeId, action: 'stop' })
    expect(stopped.status).toBe('paused')

    // 5. Test independent /ws/terminal/:id WebSocket channel
    const term = await rpcCall(ws, 't1', 'terminal.open', { workspaceId: proj.id, cols: 90, rows: 25 })
    const termWs = new WebSocket(`ws://127.0.0.1:${port}${term.wsPath}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    await new Promise<void>((resolve, reject) => {
      let buf = ''
      let sent = false
      const sendCmd = () => {
        if (sent) return
        sent = true
        termWs.send(JSON.stringify({ type: 'input', data: 'echo TERM_WS_LIVE_OK\r' }))
      }
      const timer = setTimeout(() => reject(new Error(`terminal WS timeout; saw=${buf.slice(0, 150)}`)), 12_000)
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null
      termWs.on('open', () => {
        termWs.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
        fallbackTimer = setTimeout(sendCmd, 1500)
      })
      termWs.on('message', (raw) => {
        const frame = JSON.parse(raw.toString('utf8'))
        if (frame.type === 'data') {
          buf += frame.data
          if (!sent && buf.includes('>')) {
            if (fallbackTimer) clearTimeout(fallbackTimer)
            setTimeout(sendCmd, 150)
          }
          if (buf.includes('TERM_WS_LIVE_OK')) {
            clearTimeout(timer)
            if (fallbackTimer) clearTimeout(fallbackTimer)
            resolve()
          }
        }
      })
      termWs.on('error', reject)
    })
    termWs.close()
    await rpcCall(ws, 't2', 'terminal.close', { terminalId: term.id })

    // 6. Test password change & old password rejected
    const chRes = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: 'admin', newPassword: 'newpass123' })
    })
    expect(chRes.status).toBe(200)
    const oldLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    })
    expect(oldLogin.status).toBe(401)
    const newLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'newpass123' })
    })
    expect(newLogin.status).toBe(200)

    ws.close()
    await core.stop()
  }, 45_000)
})
