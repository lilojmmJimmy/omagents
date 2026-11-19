import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startCoreServer } from '../main'
import { parseLeadingMentions } from './open-channel-strategy'

let tmpHome: string
let gitRepoDir: string
let daemonProc: ChildProcess
let daemonEndpoint: string
let mockLlmServer: http.Server
let mockLlmPort: number

type MockScenario = 'feature-workflow' | 'everyone-fanout' | 'reply-and-transfer' | 'hold-for-mcp'
let mockScenario: MockScenario = 'feature-workflow'
let releaseHoldTurn: (() => void) | null = null

function startMockMultiAgentLlm(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-collab-1' }] }))
        return
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const body = JSON.parse(raw) as {
            messages: Array<{ role: string; content: string | null; tool_call_id?: string }>
          }
          const sys = body.messages[0]?.content ?? ''
          const isSeat = (name: string) => sys.includes(`You are seated as **@${name}**`)
          const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
          const toolMsgs = body.messages.filter((m) => m.role === 'tool')

          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          const sendChunk = (delta: Record<string, unknown>) => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
          }
          const endStream = () => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 80, completion_tokens: 20 } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          }

          if (mockScenario === 'hold-for-mcp') {
            let released = false
            const done = () => {
              if (released) return
              released = true
              releaseHoldTurn = null
              sendChunk({ content: 'Held turn completed.' })
              endStream()
            }
            releaseHoldTurn = done
            setTimeout(done, 8000)
            req.on('close', () => {
              releaseHoldTurn = null
            })
            return
          }

          if (mockScenario === 'everyone-fanout') {
            sendChunk({ content: `Ack from ${isSeat('Lead') ? 'Lead' : isSeat('Coder') ? 'Coder' : 'Reviewer'}.` })
            endStream()
            return
          }

          if (mockScenario === 'reply-and-transfer') {
            if (isSeat('Lead')) {
              if (lastUser.includes('Child Task Deliverables')) {
                sendChunk({ content: `Lead received reply: ${lastUser}` })
                endStream()
                return
              }
              if (lastUser.includes('Run cycle and guardrails test')) {
                // Lead replies to an existing agent message via collab_reply
                if (toolMsgs.length === 0) {
                  sendChunk({
                    tool_calls: [
                      {
                        index: 0,
                        id: 'tc_reply_1',
                        type: 'function',
                        function: {
                          name: 'collab_reply',
                          arguments: JSON.stringify({ messageId: '#m2', text: 'Please clarify line 1.' })
                        }
                      }
                    ]
                  })
                } else {
                  sendChunk({ content: 'Waiting for teammate reply...' })
                }
                endStream()
                return
              }
              if (lastUser.includes('Transfer this work') && toolMsgs.length === 0) {
                sendChunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc_xfer',
                      type: 'function',
                      function: {
                        name: 'collab_dispatch',
                        arguments: JSON.stringify({
                          mode: 'transfer',
                          recipientMember: 'Coder',
                          instruction: 'Finish transferred task',
                          expectedResult: 'Final reply'
                        })
                      }
                    }
                  ]
                })
                endStream()
                return
              }
              sendChunk({ content: 'Lead done.' })
              endStream()
              return
            }

            if (isSeat('Coder')) {
              if (lastUser.includes('Direct clarification reply') || lastUser.includes('(member_reply,')) {
                // Deliberately try forbidden nested collab_dispatch inside member_reply!
                if (toolMsgs.length === 0) {
                  sendChunk({
                    tool_calls: [
                      {
                        index: 0,
                        id: 'tc_bad_nested',
                        type: 'function',
                        function: {
                          name: 'collab_dispatch',
                          arguments: JSON.stringify({
                            mode: 'subtask',
                            recipientMember: 'Reviewer',
                            instruction: 'Should be blocked',
                            expectedResult: 'none'
                          })
                        }
                      }
                    ]
                  })
                } else {
                  sendChunk({ content: `Coder reply result (${toolMsgs[0]?.content})` })
                }
                endStream()
                return
              }
              sendChunk({ content: 'Coder completed transfer.' })
              endStream()
              return
            }
          }

          // Default scenario: 'feature-workflow' (Lead -> Coder(worktree) -> Reviewer(inherit worktree) -> Lead(collab_publish))
          if (isSeat('Lead')) {
            const matchCoder = /childNodeId=([0-9a-f-]+)[^\n]*assignee=@Coder/i.exec(lastUser)
            const matchReviewer = /childNodeId=([0-9a-f-]+)[^\n]*assignee=@Reviewer/i.exec(lastUser)

            if (matchReviewer) {
              if (toolMsgs.length === 0) {
                sendChunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc_pub',
                      type: 'function',
                      function: {
                        name: 'collab_publish',
                        arguments: JSON.stringify({
                          text: 'Feature X implemented and verified: WORKTREE_FEATURE_OK',
                          verdict: 'done',
                          metadata: { feature: 'X' }
                        })
                      }
                    }
                  ]
                })
              } else {
                // Intentionally emit trailing text after collab_publish -> engine must NOT post a duplicate public message
                sendChunk({ content: 'Trailing log after publish (must not duplicate).' })
              }
              endStream()
              return
            }

            if (matchCoder) {
              if (toolMsgs.length === 0) {
                sendChunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc_disp_rev',
                      type: 'function',
                      function: {
                        name: 'collab_dispatch',
                        arguments: JSON.stringify({
                          mode: 'subtask',
                          recipientMember: 'Reviewer',
                          instruction: 'Inspect feature.txt in inherited worktree',
                          expectedResult: 'verification verdict',
                          workspaceMode: 'read-only',
                          inheritWorkspaceFromNodeId: matchCoder[1]
                        })
                      }
                    }
                  ]
                })
              } else {
                sendChunk({ content: 'Waiting for Reviewer...' })
              }
              endStream()
              return
            }

            if (toolMsgs.length === 0) {
              sendChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_mem',
                    type: 'function',
                    function: {
                      name: 'collab_remember',
                      arguments: JSON.stringify({ text: 'Use ESM modules' })
                    }
                  },
                  {
                    index: 1,
                    id: 'tc_disp_coder',
                    type: 'function',
                    function: {
                      name: 'collab_dispatch',
                      arguments: JSON.stringify({
                        mode: 'subtask',
                        recipientMember: 'Coder',
                        instruction: 'Write feature.txt in an isolated worktree',
                        expectedResult: 'path and summary',
                        workspaceMode: 'worktree'
                      })
                    }
                  }
                ]
              })
            } else {
              // Attempt calling collab_publish while child is still active must be rejected by tool, so we just finish interim turn
              sendChunk({ content: 'Delegated to Coder, awaiting deliverables.' })
            }
            endStream()
            return
          }

          if (isSeat('Coder')) {
            if (toolMsgs.length === 0) {
              sendChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_coder_write',
                    type: 'function',
                    function: {
                      name: 'workspace_write',
                      arguments: JSON.stringify({ path: 'feature.txt', content: 'WORKTREE_FEATURE_OK\n' })
                    }
                  }
                ]
              })
            } else {
              sendChunk({ content: 'Coder created feature.txt inside isolated git worktree.' })
            }
            endStream()
            return
          }

          if (isSeat('Reviewer')) {
            if (toolMsgs.length === 0) {
              sendChunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc_rev_read',
                    type: 'function',
                    function: {
                      name: 'workspace_read',
                      arguments: JSON.stringify({ path: 'feature.txt' })
                    }
                  }
                ]
              })
            } else {
              const fileContent = toolMsgs[0]?.content ?? ''
              sendChunk({
                content: fileContent.includes('WORKTREE_FEATURE_OK')
                  ? 'Reviewer confirmed: WORKTREE_FEATURE_OK'
                  : `Reviewer mismatch: ${fileContent}`
              })
            }
            endStream()
            return
          }

          sendChunk({ content: 'Default mock reply.' })
          endStream()
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
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-oc-'))
  gitRepoDir = path.join(tmpHome, 'collab-repo')
  process.env.MYAGENTS_HOME = tmpHome
  daemonEndpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\myagents-oc-${Date.now()}`
      : path.join(tmpHome, 'daemon.sock')

  execFileSync('git', ['init', gitRepoDir], { windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'test@myagents.local'], { cwd: gitRepoDir, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir, windowsHide: true })
  writeFileSync(path.join(gitRepoDir, 'README.md'), 'repo root\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: gitRepoDir, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: gitRepoDir, windowsHide: true })

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
  })

  const mock = await startMockMultiAgentLlm()
  mockLlmServer = mock.server
  mockLlmPort = mock.port
}, 25_000)

afterAll(() => {
  daemonProc?.kill()
  mockLlmServer?.close()
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore cleanup lock
  }
})

describe('parseLeadingMentions', () => {
  const members = [
    { id: '1', roomId: 'r', agentId: 'a1', displayName: 'Claude', roleKind: 'lead' as const, rolePrompt: '', position: 0, joinedAt: 1, removedAt: null },
    { id: '2', roomId: 'r', agentId: 'a2', displayName: 'Claude 主程', roleKind: 'member' as const, rolePrompt: '', position: 1, joinedAt: 1, removedAt: null },
    { id: '3', roomId: 'r', agentId: 'a3', displayName: '代码审查', roleKind: 'member' as const, rolePrompt: '', position: 2, joinedAt: 1, removedAt: null }
  ]

  it('matches @everyone, case-insensitive longest prefix, and CJK mentions without spaces', () => {
    const ev = parseLeadingMentions('@Everyone please check', members)
    expect(ev.everyone).toBe(true)
    expect(ev.matchedMembers).toHaveLength(3)

    const longest = parseLeadingMentions('@claude 主程 @代码审查请评审一下', members)
    expect(longest.matchedMembers.map((m) => m.id)).toEqual(['2', '3'])

    const proseAt = parseLeadingMentions('send email to foo@Claude please', members)
    expect(proseAt.matchedMembers).toHaveLength(0)
  })
})

describe('MyAgents v0.1b Open-Channel Multi-Agent Collaboration & Restart-Resilient MCP Bridge', () => {
  it('executes Lead -> Coder(worktree) -> Reviewer(inherited worktree) -> Publish, plus guardrails, reassign, pause/resume & cascade cancel', async () => {
    const dbPath = path.join(tmpHome, 'data', 'collab-test.db')
    const port = 35510 + Math.floor(Math.random() * 400)
    const core = await startCoreServer({
      host: '127.0.0.1',
      port,
      dbPath,
      daemonEndpoint,
      autoStartDaemon: false
    })

    const login = (await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    }).then((r) => r.json())) as { token: string }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Authorization: `Bearer ${login.token}` } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    const proj = await rpcCall(ws, 'p1', 'workspaces.registerProject', { name: 'CollabRepo', rootPath: gitRepoDir })
    const provider = await rpcCall(ws, 'pr1', 'providers.save', {
      name: 'MockCollab',
      kind: 'openai-compat',
      baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
      apiKey: 'sk-collab',
      defaultModel: 'mock-collab-1',
      models: ['mock-collab-1']
    })

    const lead = await rpcCall(ws, 'a1', 'agents.create', {
      name: 'Lead',
      driverKind: 'builtin',
      providerId: provider.id,
      permissionMode: 'workspace-write'
    })
    const coder = await rpcCall(ws, 'a2', 'agents.create', {
      name: 'Coder',
      driverKind: 'builtin',
      providerId: provider.id,
      permissionMode: 'workspace-write'
    })
    const reviewer = await rpcCall(ws, 'a3', 'agents.create', {
      name: 'Reviewer',
      driverKind: 'builtin',
      providerId: provider.id,
      permissionMode: 'read-only'
    })

    const room = await rpcCall(ws, 'r1', 'rooms.create', {
      title: 'Feature Team',
      strategyId: 'open-channel',
      primaryWorkspaceId: proj.id,
      members: [
        { agentId: lead.id, displayName: 'Lead', roleKind: 'lead' },
        { agentId: coder.id, displayName: 'Coder', roleKind: 'member' },
        { agentId: reviewer.id, displayName: 'Reviewer', roleKind: 'member' }
      ]
    })

    // 1. Multi-hop delegation workflow: Lead -> Coder(worktree) -> Reviewer(inherit) -> Lead(collab_publish)
    mockScenario = 'feature-workflow'
    const publishedPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting collab_publish')), 20_000)
      const onMsg = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (
          parsed.method === 'room.messageCreated' &&
          parsed.params.authorKind === 'agent' &&
          String(parsed.params.content).includes('Feature X implemented and verified')
        ) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params)
        }
      }
      ws.on('message', onMsg)
    })

    await rpcCall(ws, 'm1', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Implement feature X',
      idempotencyKey: 'oc-1'
    })
    const finalPubMsg = await publishedPromise
    expect(finalPubMsg.kind).toBe('result')

    // Give a brief tick for settlement & ensure NO duplicate public message was emitted
    await new Promise((r) => setTimeout(r, 150))
    const msgPage = await rpcCall(ws, 'ml1', 'rooms.messages', { roomId: room.id })
    const leadFinalMessages = msgPage.messages.filter(
      (m: any) => m.workNodeId === finalPubMsg.workNodeId && m.authorKind === 'agent'
    )
    expect(leadFinalMessages).toHaveLength(1)

    // Verify shared memory persisted & main repo stayed clean while worktree received feature.txt
    const roomAfter = await rpcCall(ws, 'rg1', 'rooms.get', { id: room.id })
    expect(roomAfter.sharedMemories.some((m: any) => m.text === 'Use ESM modules')).toBe(true)
    expect(existsSync(path.join(gitRepoDir, 'feature.txt'))).toBe(false)

    // Verify Coder and Reviewer executed in the EXACT same inherited git_worktree
    const nodes1 = await rpcCall(ws, 'wn1', 'workNodes.list', { roomId: room.id })
    const coderNode = nodes1.find((n: any) => n.assigneeMemberId === room.members[1].id && n.kind === 'subtask')
    const reviewerNode = nodes1.find((n: any) => n.assigneeMemberId === room.members[2].id && n.kind === 'subtask')
    expect(coderNode).toBeTruthy()
    expect(reviewerNode).toBeTruthy()
    expect(coderNode.workspaceId).not.toBe(proj.id)
    expect(reviewerNode.workspaceId).toBe(coderNode.workspaceId)
    expect(reviewerNode.workspaceMode).toBe('read-only')
    expect(reviewerNode.resultText).toContain('WORKTREE_FEATURE_OK')

    // 2. @everyone concurrent fan-out
    mockScenario = 'everyone-fanout'
    const fanoutMsgs: string[] = []
    const fanoutDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`@everyone timeout; got=${fanoutMsgs.join(',')}`)), 15_000)
      const onMsg = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.messageCreated' && parsed.params.authorKind === 'agent' && String(parsed.params.content).startsWith('Ack from ')) {
          fanoutMsgs.push(parsed.params.content)
          if (fanoutMsgs.length === 3) {
            clearTimeout(timer)
            ws.off('message', onMsg)
            resolve()
          }
        }
      }
      ws.on('message', onMsg)
    })
    await rpcCall(ws, 'm2', 'rooms.sendMessage', {
      roomId: room.id,
      content: '@everyone report ready status',
      idempotencyKey: 'oc-everyone'
    })
    await fanoutDone
    expect(fanoutMsgs.sort()).toEqual(['Ack from Coder.', 'Ack from Lead.', 'Ack from Reviewer.'])

    // 3. collab_reply (#m2) + nested dispatch blocked in member_reply + transfer mode
    mockScenario = 'reply-and-transfer'
    const replyDone = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('collab_reply timeout')), 15_000)
      const onMsg = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.messageCreated' && String(parsed.params.content).includes('Lead received reply:')) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params)
        }
      }
      ws.on('message', onMsg)
    })
    await rpcCall(ws, 'm3', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Run cycle and guardrails test',
      idempotencyKey: 'oc-reply-test'
    })
    const replySummaryMsg = await replyDone
    expect(replySummaryMsg.content).toContain('cannot invoke collab_dispatch')

    const xferDone = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('transfer timeout')), 15_000)
      const onMsg = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.messageCreated' && String(parsed.params.content).includes('Coder completed transfer.')) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params)
        }
      }
      ws.on('message', onMsg)
    })
    await rpcCall(ws, 'm4', 'rooms.sendMessage', {
      roomId: room.id,
      content: 'Transfer this work',
      idempotencyKey: 'oc-xfer-test'
    })
    await xferDone
    const nodesAfterXfer = await rpcCall(ws, 'wn2', 'workNodes.list', { roomId: room.id })
    expect(nodesAfterXfer.some((n: any) => Boolean(n.transferredToNodeId))).toBe(true)

    // 4. Pause room -> queued work stays paused -> Resume room runs it -> test reassign
    await rpcCall(ws, 'rc1', 'rooms.control', { roomId: room.id, action: 'pause' })
    mockScenario = 'everyone-fanout'
    await rpcCall(ws, 'm5', 'rooms.sendMessage', {
      roomId: room.id,
      content: '@Coder queued while paused',
      idempotencyKey: 'oc-paused-q'
    })
    await new Promise((r) => setTimeout(r, 250))
    const pausedNodes = await rpcCall(ws, 'wn3', 'workNodes.list', { roomId: room.id })
    const blockedCoderNode = pausedNodes.find((n: any) => n.instruction.includes('queued while paused'))
    expect(blockedCoderNode.status).toBe('queued')

    // Reassign that queued Coder node to Reviewer while room is paused!
    const reassigned = await rpcCall(ws, 'wc1', 'workNodes.control', {
      nodeId: blockedCoderNode.id,
      action: 'reassign',
      targetMemberId: room.members[2].id,
      note: 'Switch to Reviewer'
    })
    expect(reassigned.supersedesNodeId).toBe(blockedCoderNode.id)
    expect(reassigned.assigneeMemberId).toBe(room.members[2].id)

    const resumedAck = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('resume timeout')), 10_000)
      const onMsg = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.messageCreated' && parsed.params.workNodeId === reassigned.id) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(parsed.params)
        }
      }
      ws.on('message', onMsg)
    })
    await rpcCall(ws, 'rc2', 'rooms.control', { roomId: room.id, action: 'resume' })
    const resumedReply = await resumedAck
    expect(resumedReply.content).toBe('Ack from Reviewer.')

    ws.close()
    await core.stop()
  }, 45_000)

  it('keeps stdio MCP bridge process working seamlessly across Core restart (new port & internalToken)', async () => {
    const dbPath = path.join(tmpHome, 'data', 'mcp-restart.db')
    const port1 = 36110 + Math.floor(Math.random() * 300)
    const port2 = port1 + 51

    const core1 = await startCoreServer({
      host: '127.0.0.1',
      port: port1,
      dbPath,
      daemonEndpoint,
      autoStartDaemon: false,
      writeCoreEndpoint: true
    })

    const login1 = (await fetch(`http://127.0.0.1:${port1}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    }).then((r) => r.json())) as { token: string }
    const ws1 = new WebSocket(`ws://127.0.0.1:${port1}/rpc`, { headers: { Authorization: `Bearer ${login1.token}` } })
    await new Promise<void>((r) => ws1.once('open', r))

    const pr = await rpcCall(ws1, 'p1', 'providers.save', {
      name: 'McpHoldProvider',
      kind: 'openai-compat',
      baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
      apiKey: 'sk-mcp',
      defaultModel: 'mock-collab-1',
      models: ['mock-collab-1']
    })
    const a1 = await rpcCall(ws1, 'a1', 'agents.create', {
      name: 'BridgeAgent',
      driverKind: 'builtin',
      providerId: pr.id
    })
    const a2 = await rpcCall(ws1, 'a2', 'agents.create', {
      name: 'PeerAgent',
      driverKind: 'builtin',
      providerId: pr.id
    })
    const room = await rpcCall(ws1, 'r1', 'rooms.create', {
      title: 'MCP Bridge Restart Room',
      strategyId: 'open-channel',
      members: [
        { agentId: a1.id, displayName: 'BridgeAgent', roleKind: 'lead' },
        { agentId: a2.id, displayName: 'PeerAgent', roleKind: 'member' }
      ]
    })

    // Spawn the standalone pure Node ESM MCP bridge outside the repo root
    const here = path.dirname(fileURLToPath(import.meta.url))
    const bridgeScript = path.resolve(here, '../mcp/mcp-bridge.mjs')
    const bridgeProc = spawn(
      process.execPath,
      [bridgeScript, '--home', tmpHome, '--room', room.id, '--member', room.members[0].id],
      { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    const bridgeRl = readline.createInterface({ input: bridgeProc.stdout! })
    const bridgePending = new Map<string | number, (msg: any) => void>()
    bridgeRl.on('line', (line) => {
      const parsed = JSON.parse(line)
      const cb = bridgePending.get(parsed.id)
      if (cb) {
        bridgePending.delete(parsed.id)
        cb(parsed)
      }
    })
    const mcpCall = (id: number, method: string, params?: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP ${method} timeout`)), 8000)
        bridgePending.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        bridgeProc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
      })

    try {
      const initRes = await mcpCall(1, 'initialize', { protocolVersion: '2025-06-18' })
      expect(initRes.result.serverInfo.name).toBe('myagents-collab')
      const listRes = await mcpCall(2, 'tools/list')
      expect(listRes.result.tools.map((t: any) => t.name)).toContain('collab_remember')

      // Trigger a live running turn on Core #1 so callerNode is actively 'running'
      mockScenario = 'hold-for-mcp'
      const waitRunning = (wsClient: WebSocket) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout waiting running')), 8000)
          const onMsg = (raw: WebSocket.RawData) => {
            const p = JSON.parse(raw.toString('utf8'))
            if (p.method === 'workNode.updated' && p.params.status === 'running') {
              clearTimeout(timer)
              wsClient.off('message', onMsg)
              resolve()
            }
          }
          wsClient.on('message', onMsg)
        })
      const run1 = waitRunning(ws1)
      await rpcCall(ws1, 'm1', 'rooms.sendMessage', {
        roomId: room.id,
        content: 'Start turn 1 on core1',
        idempotencyKey: 'mcp-t1'
      })
      await run1

      const call1 = await mcpCall(3, 'tools/call', {
        name: 'collab_remember',
        arguments: { text: 'Survives Core Restart' }
      })
      expect(call1.result.isError).toBe(false)
      expect(call1.result.content[0].text).toContain('Remembered:')

      releaseHoldTurn?.()
      await new Promise((r) => setTimeout(r, 200))
      ws1.close()
      await core1.stop()

      // Start Core #2 on a DIFFERENT port + new random internalToken while bridgeProc stays alive!
      const core2 = await startCoreServer({
        host: '127.0.0.1',
        port: port2,
        dbPath,
        daemonEndpoint,
        autoStartDaemon: false,
        writeCoreEndpoint: true
      })
      const login2 = (await fetch(`http://127.0.0.1:${port2}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' })
      }).then((r) => r.json())) as { token: string }
      const ws2 = new WebSocket(`ws://127.0.0.1:${port2}/rpc`, { headers: { Authorization: `Bearer ${login2.token}` } })
      await new Promise<void>((r) => ws2.once('open', r))

      const run2 = waitRunning(ws2)
      await rpcCall(ws2, 'm2', 'rooms.sendMessage', {
        roomId: room.id,
        content: 'Start turn 2 on core2',
        idempotencyKey: 'mcp-t2'
      })
      await run2

      // Use the EXACT SAME bridgeProc stdio process without restarting it!
      const call2 = await mcpCall(4, 'tools/call', {
        name: 'collab_history',
        arguments: { limit: 10 }
      })
      expect(call2.result.isError).toBe(false)
      expect(call2.result.content[0].text).toContain('Start turn 1 on core1')
      expect(call2.result.content[0].text).toContain('Start turn 2 on core2')

      releaseHoldTurn?.()
      ws2.close()
      await core2.stop()
    } finally {
      bridgeRl.close()
      bridgeProc.kill()
    }
  }, 30_000)
})
