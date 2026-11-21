import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCoreServer } from '../packages/core/src/main.ts'

const requireCore = createRequire(new URL('../packages/core/package.json', import.meta.url))
const WebSocket = requireCore('ws')

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-claude-live-'))
const gitRepoDir = path.join(tmpHome, 'claude-repo')
process.env.MYAGENTS_HOME = tmpHome
const daemonEndpoint =
  process.platform === 'win32' ? `\\\\.\\pipe\\myagents-claude-live-${Date.now()}` : path.join(tmpHome, 'daemon.sock')

execFileSync('git', ['init', gitRepoDir], { windowsHide: true })
execFileSync('git', ['config', 'user.email', 'test@myagents.local'], { cwd: gitRepoDir, windowsHide: true })
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir, windowsHide: true })
writeFileSync(path.join(gitRepoDir, 'hello.txt'), 'Hello MyAgents!\n', 'utf8')
execFileSync('git', ['add', '.'], { cwd: gitRepoDir, windowsHide: true })
execFileSync('git', ['commit', '-m', 'init'], { cwd: gitRepoDir, windowsHide: true })

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

  const port = 35123
  core = await startCoreServer({
    host: '127.0.0.1',
    port,
    dbPath: path.join(tmpHome, 'data', 'myagents.db'),
    daemonEndpoint,
    autoStartDaemon: false
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

  const proj = await rpcCall(ws, '2', 'workspaces.registerProject', { name: 'ClaudeLiveRepo', rootPath: gitRepoDir })
  const agent = await rpcCall(ws, '3', 'agents.create', {
    name: 'ClaudeLive',
    driverKind: 'claude',
    permissionMode: 'workspace-write'
  })
  const room = await rpcCall(ws, '4', 'rooms.create', {
    strategyId: 'single',
    primaryWorkspaceId: proj.id,
    members: [{ agentId: agent.id }]
  })

  let streamChunks = 0
  let toolStarts = 0
  let toolResults = 0
  const waitReply = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude turn timeout (90s)')), 90_000)
      const onMsg = (raw) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.streamDelta') {
          if (parsed.params.kind === 'text') streamChunks++
          if (parsed.params.kind === 'tool_start') toolStarts++
          if (parsed.params.kind === 'tool_result') toolResults++
        }
        if (
          parsed.method === 'room.messageCreated' &&
          (parsed.params.authorKind === 'agent' || parsed.params.authorKind === 'system')
        ) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params)
        }
      }
      ws.on('message', onMsg)
    })

  // Turn 1: Ask Claude to read hello.txt and create claude_note.txt
  const t1 = waitReply()
  await rpcCall(ws, '5', 'rooms.sendMessage', {
    roomId: room.id,
    content:
      'Read hello.txt in the workspace, then create a file named claude_note.txt containing "CLAUDE_LIVE_VERIFIED" and reply briefly.',
    idempotencyKey: 'claude-live-1'
  })
  const r1 = await t1
  console.log('TURN1_AUTHOR:', r1.authorKind, 'TEXT:', r1.content.slice(0, 300))
  console.log('STREAM_STATS:', { streamChunks, toolStarts, toolResults })

  const diff = await rpcCall(ws, '6', 'git.diff', { workspaceId: proj.id })
  console.log(
    'GIT_DIFF_FILES:',
    diff.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions }))
  )
  let noteExists = false
  try {
    const content = readFileSync(path.join(gitRepoDir, 'claude_note.txt'), 'utf8')
    noteExists = content.includes('CLAUDE_LIVE_VERIFIED')
    console.log('NOTE_CONTENT:', JSON.stringify(content))
  } catch {
    console.log('NOTE_CONTENT: <missing>')
  }

  // Turn 2: Follow-up in same session to verify session continuity
  const t2 = waitReply()
  await rpcCall(ws, '7', 'rooms.sendMessage', {
    roomId: room.id,
    content: 'What exact string did you just write to claude_note.txt? Reply with just that string.',
    idempotencyKey: 'claude-live-2'
  })
  const r2 = await t2
  console.log('TURN2_AUTHOR:', r2.authorKind, 'TEXT:', r2.content.slice(0, 200))

  const events = await rpcCall(ws, '8', 'workNodes.events', { nodeId: r1.workNodeId })
  const roomAfter = await rpcCall(ws, '9', 'rooms.get', { id: room.id })
  console.log('TURN1_USAGE:', JSON.stringify(r1.meta?.usage))
  console.log('SESSION_FILE_PATH:', roomAfter.members[0]?.sessionFilePath)
  console.log('PERSISTED_NODE_EVENTS_COUNT:', events.length)
  console.log(
    'CLAUDE_LIVE_SUMMARY:',
    JSON.stringify({
      turn1Ok: r1.authorKind === 'agent',
      noteExists,
      turn2Ok: r2.authorKind === 'agent' && r2.content.includes('CLAUDE_LIVE_VERIFIED'),
      streamChunks,
      toolStarts,
      toolResults,
      persistedEvents: events.length,
      hasSessionFile: Boolean(roomAfter.members[0]?.sessionFilePath),
      hasUsage: Boolean(r1.meta?.usage?.tokensPerSec && r1.meta?.usage?.contextUsedTokens)
    })
  )

  ws.close()
} finally {
  if (core) await core.stop()
  daemonProc.kill()
  await new Promise((r) => setTimeout(r, 600))
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
