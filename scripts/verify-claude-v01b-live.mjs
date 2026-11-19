import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startCoreServer } from '../packages/core/src/main.ts'

const mockAnthropic = process.argv.includes('--mock-anthropic')
const requireCore = createRequire(new URL('../packages/core/package.json', import.meta.url))
const WebSocket = requireCore('ws')

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-claude-v01b-live-'))
const gitRepoDir = path.join(tmpHome, 'claude-v01b-repo')
process.env.MYAGENTS_HOME = tmpHome
const daemonEndpoint =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\myagents-claude-v01b-live-${Date.now()}`
    : path.join(tmpHome, 'daemon.sock')

execFileSync('git', ['init', gitRepoDir], { windowsHide: true })
execFileSync('git', ['config', 'user.email', 'test@myagents.local'], { cwd: gitRepoDir, windowsHide: true })
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir, windowsHide: true })
writeFileSync(path.join(gitRepoDir, 'hello.txt'), 'Hello MyAgents v0.1b!\n', 'utf8')
execFileSync('git', ['add', '.'], { cwd: gitRepoDir, windowsHide: true })
execFileSync('git', ['commit', '-m', 'init'], { cwd: gitRepoDir, windowsHide: true })

let mockServer = null
let mockPort = 0
const sawCollabTools = new Set()
let sawBlockedSubagents = false
let sawToolResult = ''

if (mockAnthropic) {
  let toolSearchSent = false
  mockServer = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }

      const body = JSON.parse(raw || '{}')
      const tools = Array.isArray(body.tools) ? body.tools : []
      for (const t of tools) {
        const name = String(t?.name || '')
        if (name === 'Agent' || name === 'Task') sawBlockedSubagents = true
        if (name.startsWith('mcp__myagents__')) sawCollabTools.add(name)
      }

      const hasToolSearch = tools.some((t) => t?.name === 'ToolSearch')
      const hasCollabRemember = tools.some((t) => t?.name === 'mcp__myagents__collab_remember')
      const messages = Array.isArray(body.messages) ? body.messages : []
      let rememberResultText = ''
      for (const m of messages) {
        if (!Array.isArray(m?.content)) continue
        for (const block of m.content) {
          if (block?.type === 'tool_result' && block.tool_use_id === 'toolu_v01b_1') {
            rememberResultText +=
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c) => c?.text || '').join('')
                  : JSON.stringify(block.content ?? '')
          }
        }
      }
      if (rememberResultText) sawToolResult = rememberResultText

      const sendEvent = (eventName, payload) => {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      sendEvent('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model: body.model || 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 1 }
        }
      })

      if (!rememberResultText && !hasCollabRemember && hasToolSearch && !toolSearchSent && raw.includes('mcp__myagents__collab_remember')) {
        toolSearchSent = true
        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_ts_1', name: 'ToolSearch', input: {} }
        })
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              query: 'select:mcp__myagents__collab_dispatch,mcp__myagents__collab_reply,mcp__myagents__collab_publish,mcp__myagents__collab_history,mcp__myagents__collab_remember',
              max_results: 10
            })
          }
        })
        sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 20 }
        })
      } else if (!rememberResultText && hasCollabRemember) {
        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' }
        })
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Persisting shared memory via mcp__myagents__collab_remember.' }
        })
        sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 })

        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_v01b_1', name: 'mcp__myagents__collab_remember', input: {} }
        })
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"text":"V01B_LIVE_MCP_OK","action":"add"}' }
        })
        sendEvent('content_block_stop', { type: 'content_block_stop', index: 1 })
        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 45 }
        })
      } else {
        const replyText = rememberResultText ? 'DONE_V01B_LIVE' : 'OK'
        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: replyText }
        })
        sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 12 }
        })
      }
      sendEvent('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  mockPort = mockServer.address().port
}

const here = path.dirname(fileURLToPath(import.meta.url))
const daemonEntry = path.resolve(here, '../packages/daemon/src/main.ts')
const daemonProc = spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
  env: { ...process.env, MYAGENTS_DAEMON_ENDPOINT: daemonEndpoint },
  stdio: 'pipe',
  windowsHide: true
})

async function rpcCall(ws, id, method, params = {}) {
  return await new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      const parsed = JSON.parse(raw.toString('utf8'))
      if (parsed.id !== id) return
      ws.off('message', onMsg)
      if (parsed.error) reject(new Error(`${method} failed: ${parsed.error.message}`))
      else resolve(parsed.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

let core
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon startup timeout')), 10_000)
    daemonProc.stdout.on('data', (d) => {
      if (String(d).includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  const port = 35220 + Math.floor(Math.random() * 200)
  core = await startCoreServer({
    host: '127.0.0.1',
    port,
    dbPath: path.join(tmpHome, 'data', 'myagents.db'),
    daemonEndpoint,
    autoStartDaemon: false,
    writeCoreEndpoint: true
  })

  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json())

  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
    headers: { Authorization: `Bearer ${login.token}` }
  })
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })

  const env = await rpcCall(ws, '1', 'system.envCheck', { refresh: true })
  console.log('ENV_CHECK:', JSON.stringify(env))

  const proj = await rpcCall(ws, '2', 'workspaces.registerProject', { name: 'ClaudeV01bLiveRepo', rootPath: gitRepoDir })
  const leadIsolation = mockAnthropic ? 'isolated-home' : 'standard'
  const lead = await rpcCall(ws, '3', 'agents.create', {
    name: 'ClaudeLead',
    driverKind: 'claude',
    isolationMode: leadIsolation,
    permissionMode: 'workspace-write'
  })

  const expectedAgentHome = path.join(tmpHome, 'agent-homes', `agent-${lead.id}`)
  if (mockAnthropic) {
    mkdirSync(expectedAgentHome, { recursive: true })
    writeFileSync(
      path.join(expectedAgentHome, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
          ANTHROPIC_AUTH_TOKEN: 'sk-ant-v01b-test'
        }
      }),
      'utf8'
    )
  }

  const helper = await rpcCall(ws, '4', 'agents.create', {
    name: 'ClaudeHelper',
    driverKind: 'claude',
    isolationMode: 'standard',
    permissionMode: 'read-only'
  })

  const room = await rpcCall(ws, '5', 'rooms.create', {
    title: 'Claude v0.1b Live Collab',
    strategyId: 'open-channel',
    primaryWorkspaceId: proj.id,
    members: [
      { agentId: lead.id, displayName: 'ClaudeLead', roleKind: 'lead' },
      { agentId: helper.id, displayName: 'ClaudeHelper', roleKind: 'member' }
    ]
  })
  const leadMemberId = room.members[0].id

  let streamChunks = 0
  let thinkingChunks = 0
  let toolStarts = 0
  let toolResults = 0
  const agentMessages = []

  const waitLeadSettled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Claude v0.1b open-channel turn timeout (120s)')), 120_000)
    const onMsg = (raw) => {
      const parsed = JSON.parse(raw.toString('utf8'))
      if (parsed.method === 'room.streamDelta') {
        if (parsed.params.kind === 'text') streamChunks++
        if (parsed.params.kind === 'thinking') thinkingChunks++
        if (parsed.params.kind === 'tool_start') {
          toolStarts++
          console.log('TOOL_START:', parsed.params.toolCall?.name)
        }
        if (parsed.params.kind === 'tool_result') toolResults++
      }
      if (parsed.method === 'room.messageCreated' && (parsed.params.authorKind === 'agent' || parsed.params.authorKind === 'system')) {
        agentMessages.push({ kind: parsed.params.kind, authorKind: parsed.params.authorKind, content: parsed.params.content })
      }
      if (parsed.method === 'workNode.updated') {
        console.log('WORK_NODE:', parsed.params.status, parsed.params.errorText || '')
        if (
          parsed.params.assigneeMemberId === leadMemberId &&
          (parsed.params.status === 'completed' || parsed.params.status === 'failed' || parsed.params.status === 'cancelled')
        ) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params)
        }
      }
    }
    ws.on('message', onMsg)
  })

  await rpcCall(ws, '6', 'rooms.sendMessage', {
    roomId: room.id,
    content:
      '@ClaudeLead Do NOT run shell commands or spawn any subagents. First call your MCP tool mcp__myagents__collab_remember with text="V01B_LIVE_MCP_OK" and action="add". After that tool succeeds, reply with just "DONE_V01B_LIVE".',
    idempotencyKey: 'claude-v01b-live-1'
  })

  const settledNode = await waitLeadSettled
  const roomAfter = await rpcCall(ws, '7', 'rooms.get', { id: room.id })
  const nodes = await rpcCall(ws, '8', 'workNodes.list', { roomId: room.id })
  const leadNode = nodes.find((n) => n.id === settledNode.id)
  const leadMemberAfter = roomAfter.members.find((m) => m.id === leadMemberId)
  const memorySaved = roomAfter.sharedMemories.some((m) => m.text === 'V01B_LIVE_MCP_OK')
  const sessionFilePath = leadMemberAfter?.sessionFilePath ?? null
  const sessionFileExists = Boolean(sessionFilePath && existsSync(sessionFilePath))
  const sessionInIsolatedHome =
    !mockAnthropic || Boolean(sessionFilePath && sessionFilePath.toLowerCase().startsWith(expectedAgentHome.toLowerCase()))

  const summary = {
    mode: mockAnthropic ? 'mock-anthropic-isolated-home' : 'live-upstream-standard',
    nodeStatus: settledNode.status,
    errorText: settledNode.errorText ?? null,
    memorySaved,
    sharedMemories: roomAfter.sharedMemories.map((m) => m.text),
    sawCollabTools: [...sawCollabTools].sort(),
    sawBlockedSubagents,
    sawToolResult,
    hasAgentMessage: agentMessages.some((m) => m.authorKind === 'agent'),
    agentMessages: agentMessages.map((m) => ({ kind: m.kind, preview: String(m.content).slice(0, 120) })),
    streamChunks,
    thinkingChunks,
    toolStarts,
    toolResults,
    usage: leadNode?.usage ?? null,
    sessionFilePath,
    sessionFileExists,
    sessionInIsolatedHome
  }
  console.log('CLAUDE_V01B_LIVE_SUMMARY:', JSON.stringify(summary, null, 2))

  if (settledNode.status !== 'completed') {
    throw new Error(`ClaudeLead node did not complete: ${settledNode.status} (${settledNode.errorText})`)
  }
  if (!memorySaved) {
    throw new Error('Claude CLI did not persist shared memory "V01B_LIVE_MCP_OK" via stdio MCP bridge')
  }
  if (!sessionFileExists) {
    throw new Error(`Expected Claude session JSONL file to exist, got: ${sessionFilePath}`)
  }
  if (mockAnthropic) {
    if (sawCollabTools.size !== 5) {
      throw new Error(`Expected all 5 collab MCP tools exposed to Claude, got ${sawCollabTools.size}: ${[...sawCollabTools].join(', ')}`)
    }
    if (sawBlockedSubagents) {
      throw new Error('Agent or Task tool was NOT stripped from Claude tools list!')
    }
    if (!sawToolResult.includes('Remembered')) {
      throw new Error(`Expected MCP tool result to contain "Remembered", got: ${sawToolResult}`)
    }
    if (!sessionInIsolatedHome) {
      throw new Error(`Expected session JSONL inside isolated home ${expectedAgentHome}, got: ${sessionFilePath}`)
    }
  }

  ws.close()
} finally {
  if (core) await core.stop()
  if (mockServer) mockServer.close()
  daemonProc.kill()
  await new Promise((r) => setTimeout(r, 600))
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore cleanup EBUSY on Windows
  }
}
