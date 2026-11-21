import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { myagentsBlobsDir, myagentsHome } from '@myagents/protocol/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startCoreServer } from '../main'
import { BlobService } from './blob-service'
import { CoreDatabase } from './database'

let tmpDir: string
let daemonProc: ChildProcess
let daemonEndpoint: string
const prevHome = process.env.MYAGENTS_HOME

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-blobs-'))
  process.env.MYAGENTS_HOME = path.join(tmpDir, 'home')
  mkdirSync(process.env.MYAGENTS_HOME, { recursive: true })
  daemonEndpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\myagents-blob-test-${Date.now()}` : path.join(tmpDir, 'daemon.sock')

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
})

afterAll(() => {
  daemonProc?.kill()
  if (prevHome === undefined) delete process.env.MYAGENTS_HOME
  else process.env.MYAGENTS_HOME = prevHome
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore Windows cleanup race
  }
})

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
  timeoutMs = 15_000
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

describe('BlobService & Manual Cleanup (T-101)', () => {
  it('deduplicates SHA-256 blobs, tracks multi-owner refs, never auto-deletes, and purges only on manual call', () => {
    const db = new CoreDatabase(':memory:')
    const blobs = new BlobService(db)

    const payload = Buffer.from('ERROR: connection pool exhausted at line 42\n', 'utf8')
    const f1 = blobs.storeBuffer({ filename: 'app.log', mime: 'text/plain', buffer: payload })
    const f2 = blobs.storeBuffer({ filename: 'copy.log', mime: 'text/plain', buffer: payload })
    expect(f1.fileId).not.toBe(f2.fileId)

    const meta1 = blobs.getFileMeta(f1.fileId)
    const meta2 = blobs.getFileMeta(f2.fileId)
    expect(meta1.sha256).toBe(meta2.sha256)
    expect(existsSync(meta1.absPath)).toBe(true)
    expect(meta1.absPath.startsWith(myagentsBlobsDir())).toBe(true)
    expect(blobs.readTextPreview(f1.fileId)).toContain('connection pool exhausted')

    const binBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    const binFile = blobs.storeBuffer({ filename: 'icon.png', mime: 'image/png', buffer: binBuf })
    expect(blobs.readTextPreview(binFile.fileId)).toBeNull()

    blobs.attachRefs([f1.fileId], 'message', 'msg-1')
    blobs.attachRefs([f2.fileId], 'inbox', 'inb-1')
    blobs.attachRefs([binFile.fileId], 'message', 'msg-2')

    // Releasing msg-1 still leaves f2 referenced by inbox -> no physical deletion, no outbox entry
    blobs.releaseOwnerRefs('message', ['msg-1'])
    expect(existsSync(meta1.absPath)).toBe(true)
    let summary = blobs.getStorageSummary()
    expect(summary.unreferencedFiles).toBe(1)
    expect(summary.unreferencedBytes).toBe(0)
    expect(summary.outboxPendingCount).toBe(0)

    // Releasing inb-1 leaves zero refs for that sha256 -> outbox entry created, blob STILL on disk (manual cleanup only)
    blobs.releaseOwnerRefs('inbox', ['inb-1'])
    expect(existsSync(meta1.absPath)).toBe(true)
    summary = blobs.getStorageSummary()
    expect(summary.unreferencedFiles).toBe(2)
    expect(summary.unreferencedBytes).toBe(payload.byteLength)
    expect(summary.outboxPendingCount).toBe(1)

    // Manual purge deletes unreferenced sha256 blob and keeps referenced icon.png intact
    const purge = blobs.purgeUnreferenced()
    expect(purge.deletedFileRecords).toBe(2)
    expect(purge.deletedPhysicalBlobs).toBe(1)
    expect(purge.reclaimedBytes).toBe(payload.byteLength)
    expect(purge.errors).toEqual([])
    expect(existsSync(meta1.absPath)).toBe(false)
    expect(existsSync(blobs.getFileMeta(binFile.fileId).absPath)).toBe(true)

    db.close()
  })

  it('serves HTTP upload/download safely, attaches blobs to chat & agent context, and cleans up after room deletion', async () => {
    let lastUserPrompt = ''
    const mockLlm = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> }
          lastUserPrompt = parsed.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .join('\n')
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Read the log cleanly.' } }] })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => mockLlm.listen(0, '127.0.0.1', () => r()))
    const llmPort = (mockLlm.address() as { port: number }).port

    const port = 38100 + Math.floor(Math.random() * 400)
    const core = await startCoreServer({
      host: '127.0.0.1',
      port,
      dbPath: path.join(myagentsHome(), 'data', 'blobs.db'),
      daemonEndpoint,
      autoStartDaemon: false
    })

    const loginRes = (await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    }).then((r) => r.json())) as { token: string }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { Authorization: `Bearer ${loginRes.token}` } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    try {
      // 1. HTTP Upload HTML (must download as attachment) and PNG (inline allowed)
      const htmlForm = new FormData()
      htmlForm.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'xss.html')
      const htmlRef = (await fetch(`http://127.0.0.1:${port}/api/blobs/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginRes.token}` },
        body: htmlForm
      }).then((r) => r.json())) as { fileId: string }

      const htmlDl = await fetch(`http://127.0.0.1:${port}/api/blobs/${htmlRef.fileId}`, {
        headers: { Authorization: `Bearer ${loginRes.token}` }
      })
      expect(htmlDl.status).toBe(200)
      expect(htmlDl.headers.get('x-content-type-options')).toBe('nosniff')
      expect(htmlDl.headers.get('content-disposition')).toMatch(/^attachment;/i)

      const pngForm = new FormData()
      pngForm.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'shot.png')
      const pngRef = (await fetch(`http://127.0.0.1:${port}/api/blobs/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginRes.token}` },
        body: pngForm
      }).then((r) => r.json())) as { fileId: string }

      const pngInline = await fetch(`http://127.0.0.1:${port}/api/blobs/${pngRef.fileId}`, {
        headers: { Authorization: `Bearer ${loginRes.token}` }
      })
      expect(pngInline.headers.get('content-disposition')).toMatch(/^inline;/i)

      const logForm = new FormData()
      logForm.append('file', new Blob(['FATAL: trace marker xyz-999'], { type: 'text/plain' }), 'trace.log')
      const logRef = (await fetch(`http://127.0.0.1:${port}/api/blobs/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginRes.token}` },
        body: logForm
      }).then((r) => r.json())) as { fileId: string }

      // 2. Chat sendMessage with attachmentFileIds injects preview into agent prompt
      const prov = await rpcCall(ws, 'p1', 'providers.save', {
        name: 'MockLlm',
        kind: 'openai-compat',
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        apiKey: 'sk-blob',
        defaultModel: 'mock-1',
        models: ['mock-1']
      })
      const bot = await rpcCall(ws, 'a1', 'agents.create', {
        name: 'AttachBot',
        driverKind: 'builtin',
        providerId: prov.id
      })
      const room = await rpcCall(ws, 'r1', 'rooms.create', {
        title: 'Attach Room',
        strategyId: 'single',
        members: [{ agentId: bot.id }]
      })

      const doneEv = waitNotification(
        ws,
        (m, p) => m === 'workNode.updated' && p.roomId === room.id && p.status === 'completed'
      )
      const sent = await rpcCall(ws, 'm1', 'rooms.sendMessage', {
        roomId: room.id,
        content: 'Inspect attached log',
        attachmentFileIds: [logRef.fileId],
        idempotencyKey: 'msg-att-1'
      })
      expect(sent.message.attachments).toHaveLength(1)
      await doneEv
      expect(lastUserPrompt).toContain('[Attached Files]')
      expect(lastUserPrompt).toContain('FATAL: trace marker xyz-999')

      // 3. Delete room moves attachment into unreferenced queue, purge requires confirm:true
      await rpcCall(ws, 'd1', 'rooms.delete', { id: room.id })
      await expect(rpcCall(ws, 'bad-purge', 'blobs.purgeUnreferenced', {})).rejects.toThrow(/Invalid parameters/i)

      const beforePurge = await rpcCall(ws, 'sum1', 'blobs.summary')
      expect(beforePurge.unreferencedFiles).toBe(3)
      expect(beforePurge.outboxPendingCount).toBe(1)

      const purgeRes = await rpcCall(ws, 'ok-purge', 'blobs.purgeUnreferenced', { confirm: true })
      expect(purgeRes.deletedFileRecords).toBe(3)
      expect(purgeRes.deletedPhysicalBlobs).toBe(3)

      const afterPurge = await rpcCall(ws, 'sum2', 'blobs.summary')
      expect(afterPurge.totalFiles).toBe(0)
      expect(afterPurge.outboxPendingCount).toBe(0)
    } finally {
      ws.close()
      await core.stop()
      mockLlm.close()
    }
  })
})
