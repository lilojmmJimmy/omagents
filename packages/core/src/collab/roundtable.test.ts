import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startCoreServer } from '../main'

interface RecordedCall {
  seat: string
  system: string
  user: string
  allMessages: Array<{ role: string; content: string | null }>
}

let tmpHome: string
let gitRepoDir: string
let daemonProc: ChildProcess
let daemonEndpoint: string
let mockLlmServer: http.Server
let mockLlmPort: number

let scenario: 'blind-and-interject' | 'anonymous-failure-handoff' = 'blind-and-interject'
let recordedCalls: RecordedCall[] = []
let failMemberB = false

// Explicit gate to hold Round 1 of PeerB/Chair until test inspects PeerA's private message state
let holdRound1Peers = false
let peerAGateResolved: (() => void) | null = null
const peerBReleaseGates: Array<() => void> = []

function parseSeatName(sys: string): string {
  const m = /You are seated as \*\*@([^*]+)\*\*/.exec(sys)
  return m?.[1]?.trim() || 'Unknown'
}

function startMockRoundtableLlm(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-rt-1' }] }))
        return
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          void (async () => {
            const body = JSON.parse(raw) as {
              messages: Array<{ role: string; content: string | null }>
            }
            const sys = body.messages[0]?.content ?? ''
            const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
            const seat = parseSeatName(sys)
            const toolMsgs = body.messages.filter((m) => m.role === 'tool')

            recordedCalls.push({ seat, system: sys, user: lastUser, allMessages: body.messages })

            if (scenario === 'anonymous-failure-handoff' && seat === 'Member B' && failMemberB) {
              res.writeHead(400, { 'Content-Type': 'text/plain' })
              res.end('Forced partial failure on Member B')
              return
            }

            if (
              scenario === 'blind-and-interject' &&
              holdRound1Peers &&
              lastUser.includes('[Round 1 Independent Position]') &&
              seat !== 'PeerA'
            ) {
              await new Promise<void>((r) => {
                peerBReleaseGates.push(r)
              })
            }

            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
            const sendChunk = (delta: Record<string, unknown>) => {
              res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
            }
            const endStream = () => {
              res.write(
                `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 60, completion_tokens: 20 } })}\n\n`
              )
              res.write('data: [DONE]\n\n')
              res.end()
            }

            if (scenario === 'blind-and-interject') {
              if (lastUser.includes('round_post') || lastUser.includes('[Round 1 Independent Position]')) {
                if (lastUser.includes('[Round 1 Independent Position]')) {
                  if (seat === 'PeerA') {
                    sendChunk({ content: 'BLIND_PEER_A_R1: prefer blue-green cutover' })
                    endStream()
                    peerAGateResolved?.()
                    return
                  }
                  sendChunk({ content: `BLIND_${seat.toUpperCase()}_R1: rolling update stance` })
                  endStream()
                  return
                }
                if (lastUser.includes('[Round 2 Roundtable Peer Review]')) {
                  sendChunk({ content: `ROUND2_${seat}: aligned after seeing interjection` })
                  endStream()
                  return
                }
              }
              if (lastUser.includes('summary') || lastUser.includes('[Roundtable Chair Summary]')) {
                if (toolMsgs.length === 0) {
                  sendChunk({
                    tool_calls: [
                      {
                        index: 0,
                        id: 'tc_rt_sum_1',
                        type: 'function',
                        function: {
                          name: 'collab_publish',
                          arguments: JSON.stringify({
                            text: 'CHAIR_SUMMARY_FINAL: Use blue-green cutover with zero-downtime migration.',
                            verdict: 'done'
                          })
                        }
                      }
                    ]
                  })
                } else {
                  sendChunk({ content: 'Summary published.' })
                }
                endStream()
                return
              }
            }

            if (scenario === 'anonymous-failure-handoff') {
              if (lastUser.includes('[Round 1 Independent Position]')) {
                sendChunk({ content: `ANON_${seat}_R1: note regarding @PeerA module check` })
                endStream()
                return
              }
              if (lastUser.includes('[Round 2 Roundtable Peer Review]')) {
                if (toolMsgs.length === 0) {
                  sendChunk({
                    tool_calls: [
                      {
                        index: 0,
                        id: `tc_r2_${seat}`,
                        type: 'function',
                        function: {
                          name: 'collab_publish',
                          arguments: JSON.stringify({
                            text: `ANON_${seat}_R2: consensus reached`,
                            verdict: 'hold'
                          })
                        }
                      }
                    ]
                  })
                } else {
                  sendChunk({ content: 'Round 2 stance published.' })
                }
                endStream()
                return
              }
              if (lastUser.includes('[Roundtable Chair Summary]')) {
                sendChunk({ content: 'CHAIR_ANON_SUMMARY: All anonymous seats converged.' })
                endStream()
                return
              }
              sendChunk({ content: `HANDOFF_EXEC_${seat}: executing summary plan.` })
              endStream()
              return
            }

            sendChunk({ content: `Ack from ${seat}` })
            endStream()
          })()
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
      if (parsed.error) reject(Object.assign(new Error(parsed.error.message), { code: parsed.error.code }))
      else resolve(parsed.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

function waitNotification(
  ws: WebSocket,
  predicate: (method: string, params: any) => boolean,
  timeoutMs = 20_000
): Promise<{ method: string; params: any }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`Timeout waiting notification after ${timeoutMs}ms`))
    }, timeoutMs)
    const onMsg = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(raw.toString('utf8'))
      if (!parsed.method) return
      if (predicate(parsed.method, parsed.params)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve({ method: parsed.method, params: parsed.params })
      }
    }
    ws.on('message', onMsg)
  })
}

beforeAll(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'myagents-rt-'))
  gitRepoDir = path.join(tmpHome, 'rt-repo')
  process.env.MYAGENTS_HOME = tmpHome
  daemonEndpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\myagents-rt-${Date.now()}` : path.join(tmpHome, 'daemon.sock')

  execFileSync('git', ['init', gitRepoDir], { windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'test@myagents.local'], { cwd: gitRepoDir, windowsHide: true })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir, windowsHide: true })
  writeFileSync(path.join(gitRepoDir, 'README.md'), 'roundtable repo\n', 'utf8')
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

  const mock = await startMockRoundtableLlm()
  mockLlmServer = mock.server
  mockLlmPort = mock.port
}, 25_000)

afterAll(() => {
  daemonProc?.kill()
  mockLlmServer?.close()
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('MyAgents v0.1c Pregel Super-step Roundtable Strategy', () => {
  it('enforces blind round 1 private isolation, barrier atomic reveal, mid-discussion interjection, and Chair summary', async () => {
    const port = 36200 + Math.floor(Math.random() * 400)
    const core = await startCoreServer({
      host: '127.0.0.1',
      port,
      dbPath: path.join(tmpHome, 'data', 'rt1.db'),
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

    try {
      const proj = await rpcCall(ws, 'p1', 'workspaces.registerProject', { name: 'RTRepo', rootPath: gitRepoDir })
      const provider = await rpcCall(ws, 'pr1', 'providers.save', {
        name: 'MockRT',
        kind: 'openai-compat',
        baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
        apiKey: 'sk-rt',
        defaultModel: 'mock-rt-1',
        models: ['mock-rt-1']
      })

      const chair = await rpcCall(ws, 'a1', 'agents.create', {
        name: 'Chair',
        driverKind: 'builtin',
        providerId: provider.id
      })
      const peerA = await rpcCall(ws, 'a2', 'agents.create', {
        name: 'PeerA',
        driverKind: 'builtin',
        providerId: provider.id
      })
      const peerB = await rpcCall(ws, 'a3', 'agents.create', {
        name: 'PeerB',
        driverKind: 'builtin',
        providerId: provider.id
      })

      const room = await rpcCall(ws, 'r1', 'rooms.create', {
        title: 'Arch Roundtable',
        strategyId: 'roundtable',
        strategyConfig: { maxRounds: 2, blindFirstRound: true, anonymous: false, autoAdvance: false },
        primaryWorkspaceId: proj.id,
        members: [
          { agentId: chair.id, displayName: 'Chair', roleKind: 'chair' },
          { agentId: peerA.id, displayName: 'PeerA', roleKind: 'member' },
          { agentId: peerB.id, displayName: 'PeerB', roleKind: 'member' }
        ]
      })

      scenario = 'blind-and-interject'
      recordedCalls = []
      holdRound1Peers = true

      let peerAMsgSeenRevealed = false
      const revealsObserved: any[] = []
      const onReveal = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (parsed.method === 'room.messagesRevealed') {
          revealsObserved.push(parsed.params)
          peerAMsgSeenRevealed = true
        }
      }
      ws.on('message', onReveal)

      const peerAFinished = new Promise<void>((r) => {
        peerAGateResolved = r
      })
      const peerAMsgPromise = waitNotification(
        ws,
        (method, params) => method === 'room.messageCreated' && params.authorName === 'PeerA'
      )

      await rpcCall(ws, 'm1', 'rooms.sendMessage', {
        roomId: room.id,
        content: 'Evaluate cutover plan',
        idempotencyKey: 'rt-topic-1'
      })

      await peerAFinished
      await peerAMsgPromise

      // Mid-barrier check: PeerA's message MUST stay private and MUST NOT yet be revealed
      expect(peerAMsgSeenRevealed).toBe(false)
      const midMsgs = await rpcCall(ws, 'gm1', 'rooms.messages', { roomId: room.id })
      const peerAR1Msg = midMsgs.messages.find((m: any) => String(m.content).includes('BLIND_PEER_A_R1'))
      expect(peerAR1Msg).toBeDefined()
      expect(peerAR1Msg.visibilityScope).toBe('private')

      // Check Round 1 prompts recorded so far: PeerB & Chair never saw BLIND_PEER_A_R1
      for (const call of recordedCalls.filter((c) => c.seat !== 'PeerA')) {
        expect(call.system).not.toContain('BLIND_PEER_A_R1')
        expect(call.user).not.toContain('BLIND_PEER_A_R1')
      }

      // Now release PeerB and Chair to complete Superstep 1 Barrier
      const pausedAfterR1 = waitNotification(
        ws,
        (method, params) =>
          method === 'room.updated' && params.id === room.id && params.strategyState?.phase === 'awaiting_next_round'
      )
      holdRound1Peers = false
      const gates = peerBReleaseGates.splice(0)
      for (const release of gates) release()

      await pausedAfterR1
      expect(revealsObserved.length).toBeGreaterThanOrEqual(1)
      expect(revealsObserved.some((r) => r.messageIds.includes(peerAR1Msg.id))).toBe(true)

      const afterR1Msgs = await rpcCall(ws, 'gm2', 'rooms.messages', { roomId: room.id })
      const revealedPeerA = afterR1Msgs.messages.find((m: any) => m.id === peerAR1Msg.id)
      expect(revealedPeerA.visibilityScope).toBe('public')

      // Mid-discussion human interjection must NOT reset currentRound to 1 or restart discussion
      await rpcCall(ws, 'int1', 'rooms.sendMessage', {
        roomId: room.id,
        content: 'INTERJECTION: Prioritize zero-downtime migration',
        idempotencyKey: 'rt-interject-1'
      })
      const roomAfterInterject = await rpcCall(ws, 'rg1', 'rooms.get', { id: room.id })
      expect(roomAfterInterject.strategyState.currentRound).toBe(1)
      expect(roomAfterInterject.strategyState.phase).toBe('awaiting_next_round')

      // Advance manually to Round 2 -> auto-summarizes into done after maxRounds=2
      recordedCalls = []
      const donePromise = waitNotification(
        ws,
        (method, params) => method === 'room.updated' && params.id === room.id && params.state === 'done'
      )
      await rpcCall(ws, 'ctrl1', 'rooms.control', { roomId: room.id, action: 'next_round' })
      await donePromise

      // Verify Round 2 included both revealed BLIND_PEER_A_R1 and the human interjection
      const r2Calls = recordedCalls.filter((c) => c.user.includes('[Round 2 Roundtable Peer Review]'))
      expect(r2Calls.length).toBe(3)
      for (const c of r2Calls) {
        expect(c.system).toContain('BLIND_PEER_A_R1')
        expect(c.system).toContain('INTERJECTION: Prioritize zero-downtime migration')
      }

      const finalMsgs = await rpcCall(ws, 'gm3', 'rooms.messages', { roomId: room.id })
      const summaryMsg = finalMsgs.messages.find((m: any) => m.kind === 'summary')
      expect(summaryMsg).toBeDefined()
      expect(summaryMsg.content).toContain('CHAIR_SUMMARY_FINAL')
      ws.off('message', onReveal)
    } finally {
      ws.close()
      await core.stop()
    }
  }, 35_000)

  it('masks identities in anonymous mode, pauses on partial failure, recovers, and preserves sharedMemories on handoff', async () => {
    const port = 36600 + Math.floor(Math.random() * 400)
    const core = await startCoreServer({
      host: '127.0.0.1',
      port,
      dbPath: path.join(tmpHome, 'data', 'rt2.db'),
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

    try {
      const proj = await rpcCall(ws, 'p2', 'workspaces.registerProject', { name: 'RTRepo2', rootPath: gitRepoDir })
      const provider = await rpcCall(ws, 'pr2', 'providers.save', {
        name: 'MockRT2',
        kind: 'openai-compat',
        baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
        apiKey: 'sk-rt2',
        defaultModel: 'mock-rt-1',
        models: ['mock-rt-1']
      })

      const chair = await rpcCall(ws, 'a1', 'agents.create', {
        name: 'Chair',
        driverKind: 'builtin',
        providerId: provider.id
      })
      const peerA = await rpcCall(ws, 'a2', 'agents.create', {
        name: 'PeerA',
        driverKind: 'builtin',
        providerId: provider.id
      })
      const peerB = await rpcCall(ws, 'a3', 'agents.create', {
        name: 'PeerB',
        driverKind: 'builtin',
        providerId: provider.id
      })

      const room = await rpcCall(ws, 'r2', 'rooms.create', {
        title: 'Secret Architecture Review',
        strategyId: 'roundtable',
        strategyConfig: { maxRounds: 2, blindFirstRound: true, anonymous: true, autoAdvance: true },
        primaryWorkspaceId: proj.id,
        members: [
          { agentId: chair.id, displayName: 'Chair', roleKind: 'chair' },
          { agentId: peerA.id, displayName: 'PeerA', roleKind: 'member' },
          { agentId: peerB.id, displayName: 'PeerB', roleKind: 'member' }
        ]
      })

      await rpcCall(ws, 'ru1', 'rooms.update', {
        id: room.id,
        sharedMemories: [{ id: 'mem-1', text: 'MEM_TOKEN_STRICT_SECURITY', authorId: 'human', updatedAt: Date.now() }]
      })

      scenario = 'anonymous-failure-handoff'
      recordedCalls = []
      failMemberB = true

      const pausedPartialPromise = waitNotification(
        ws,
        (method, params) =>
          method === 'room.updated' &&
          params.id === room.id &&
          params.state === 'paused' &&
          params.strategyState?.phase === 'paused_partial_failure'
      )

      await rpcCall(ws, 'm2', 'rooms.sendMessage', {
        roomId: room.id,
        content: 'Audit API tokens',
        idempotencyKey: 'rt-anon-1'
      })

      await pausedPartialPromise
      failMemberB = false

      // Verify anonymous masking scrubbed real names in the room collaboration section
      for (const c of recordedCalls) {
        expect(c.system).toContain('Anonymous Roundtable')
        expect(c.system).toContain('Member A')
        const collabSection = c.system.slice(c.system.indexOf('# Collaboration Room'))
        expect(collabSection).not.toContain('Chair')
        expect(collabSection).not.toContain('PeerA')
        expect(collabSection).not.toContain('PeerB')
      }

      // Recover via next_round -> Round 2 emits verdict='hold' on all 3 -> converges straight to Chair summary -> done!
      recordedCalls = []
      const donePromise = waitNotification(
        ws,
        (method, params) => method === 'room.updated' && params.id === room.id && params.state === 'done'
      )
      await rpcCall(ws, 'ctrl2', 'rooms.control', { roomId: room.id, action: 'next_round' })
      await donePromise

      // Verify Round 2 ran all 3 distinct seats and scrubbed '@PeerA' inside transcript to '@Member B'
      const r2Calls = recordedCalls.filter((c) => c.user.includes('[Round 2 Roundtable Peer Review]'))
      expect(new Set(r2Calls.map((c) => c.seat)).size).toBe(3)
      for (const c of r2Calls) {
        expect(c.system).toContain('@Member B')
        expect(c.system).not.toContain('@PeerA')
      }

      // Handoff to open-channel & verify sharedMemories + initial task execution
      const handoffDonePromise = waitNotification(
        ws,
        (method, params) => method === 'room.messageCreated' && String(params.content).includes('HANDOFF_EXEC_')
      )
      const handoffRoom = await rpcCall(ws, 'ho1', 'rooms.handoff', {
        sourceRoomId: room.id,
        targetStrategyId: 'open-channel',
        title: 'Handoff Exec Room',
        members: [
          { agentId: chair.id, displayName: 'Chair', roleKind: 'lead' },
          { agentId: peerA.id, displayName: 'PeerA', roleKind: 'member' }
        ]
      })

      expect(handoffRoom.strategyId).toBe('open-channel')
      expect(handoffRoom.sharedMemories.some((m: any) => m.text === 'MEM_TOKEN_STRICT_SECURITY')).toBe(true)
      await handoffDonePromise
    } finally {
      ws.close()
      await core.stop()
    }
  }, 35_000)
})
