import { timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { JsonRpcRequestSchema, RPC_ERROR_CODES, type JsonRpcNotification } from '@myagents/protocol'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { AppError } from '../errors'
import { parseCookieHeader, SESSION_COOKIE_NAME, type AuthService } from '../security/auth-service'
import type { BlobService } from '../storage/blob-service'
import { resolveContainedPath } from '../workspace/path-guard'
import type { TerminalService } from '../workspace/terminal-service'
import type { WorkspaceService } from '../workspace/workspace-service'
import type { RpcRouter } from './rpc-router'

export interface HttpServerDeps {
  auth: AuthService
  rpcRouter: RpcRouter
  workspaces: WorkspaceService
  terminals: TerminalService
  blobs?: BlobService
  getHealth: () => { ok: boolean; daemonConnected: boolean; reconciling: boolean; uptimeMs: number; version: string }
  isNonLoopback: boolean
  internalToken?: string
  onInternalMcpCall?: (req: {
    roomId: string
    memberId: string
    toolName: string
    args: Record<string, unknown>
    toolCallId: string
  }) => Promise<{ ok: boolean; output: string; isError?: boolean }>
  onGenericWebhook?: (
    hookId: string,
    secret: string,
    req: { headers: Record<string, string>; rawBody: Buffer }
  ) => Promise<unknown>
  onPluginWebhook?: (
    pluginId: string,
    instanceId: string,
    req: { headers: Record<string, string>; rawBody: Buffer }
  ) => Promise<unknown>
}

function normalizeHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(',')
  }
  return out
}

function extractRequestToken(headers: IncomingMessage['headers']): string | undefined {
  const authHeader = headers.authorization
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim()
  }
  const cookies = parseCookieHeader(headers.cookie)
  return cookies[SESSION_COOKIE_NAME]
}

export interface CoreHttpServer {
  fastify: FastifyInstance
  broadcast(method: string, params: unknown): void
  listen(host: string, port: number): Promise<void>
  close(): Promise<void>
}

export async function createCoreHttpServer(deps: HttpServerDeps): Promise<CoreHttpServer> {
  const fastify = Fastify({ logger: false })
  await fastify.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } })

  const rpcClients = new Set<WebSocket>()

  const broadcast = (method: string, params: unknown) => {
    const frame: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    const text = JSON.stringify(frame)
    for (const ws of rpcClients) {
      if (ws.readyState === ws.OPEN) ws.send(text)
    }
  }

  const requireAuth = (req: FastifyRequest): { username: string; token: string } => {
    const token = extractRequestToken(req.headers)
    const session = deps.auth.verifySession(token)
    if (!session || !token) {
      throw new AppError(RPC_ERROR_CODES.UNAUTHORIZED, 'unauthorized', 'Authentication required')
    }
    return { username: session.username, token }
  }

  // Error mapper for REST endpoints
  fastify.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      const httpStatus =
        error.code === RPC_ERROR_CODES.UNAUTHORIZED
          ? 401
          : error.code === RPC_ERROR_CODES.FORBIDDEN
            ? 403
            : error.code === RPC_ERROR_CODES.NOT_FOUND
              ? 404
              : error.code === RPC_ERROR_CODES.CONFLICT
                ? 409
                : 400
      return reply.status(httpStatus).send({ error: error.reason, message: error.message })
    }
    const msg = error instanceof Error ? error.message : String(error)
    return reply.status(500).send({ error: 'internal_error', message: msg })
  })

  // Health
  fastify.get('/health', async () => deps.getHealth())

  // Internal MCP stdio bridge endpoint (authenticated via 0600 core.json internalToken)
  fastify.post('/api/internal/mcp/call', async (req) => {
    const provided = extractRequestToken(req.headers) || ''
    const expected = deps.internalToken || ''
    const a = Buffer.from(provided, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError(RPC_ERROR_CODES.UNAUTHORIZED, 'unauthorized', 'Invalid internal MCP token')
    }
    if (!deps.onInternalMcpCall) {
      throw new AppError(RPC_ERROR_CODES.METHOD_NOT_FOUND, 'method_not_found', 'Internal MCP handler not registered')
    }
    const body = (req.body ?? {}) as {
      roomId?: string
      memberId?: string
      toolName?: string
      args?: Record<string, unknown>
      toolCallId?: string
    }
    if (!body.roomId || !body.memberId || !body.toolName) {
      throw new AppError(RPC_ERROR_CODES.INVALID_PARAMS, 'invalid_params', 'Missing roomId, memberId, or toolName')
    }
    return await deps.onInternalMcpCall({
      roomId: String(body.roomId),
      memberId: String(body.memberId),
      toolName: String(body.toolName),
      args: body.args && typeof body.args === 'object' ? body.args : {},
      toolCallId: String(body.toolCallId || `mcp-${Date.now()}`)
    })
  })

  // Minimal Auth REST endpoints
  fastify.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string }
    const res = deps.auth.login(String(body.username ?? ''), String(body.password ?? ''))
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(res.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`
    )
    return {
      ok: true,
      username: res.username,
      token: res.token,
      defaultPasswordWarning: deps.isNonLoopback && deps.auth.isDefaultPassword()
    }
  })

  fastify.post('/api/auth/logout', async (req, reply) => {
    const token = extractRequestToken(req.headers)
    deps.auth.logout(token)
    reply.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    return { ok: true }
  })

  fastify.get('/api/auth/me', async (req) => {
    const token = extractRequestToken(req.headers)
    const session = deps.auth.verifySession(token)
    if (!session) return { authenticated: false }
    return {
      authenticated: true,
      username: session.username,
      defaultPasswordWarning: deps.isNonLoopback && deps.auth.isDefaultPassword()
    }
  })

  fastify.post('/api/auth/change-password', async (req) => {
    const { token } = requireAuth(req)
    const body = (req.body ?? {}) as { oldPassword?: string; newPassword?: string }
    deps.auth.changePassword(token, String(body.oldPassword ?? ''), String(body.newPassword ?? ''))
    return { ok: true }
  })

  // Workspace file upload & download
  fastify.post('/api/workspaces/:workspaceId/upload', async (req) => {
    requireAuth(req)
    const { workspaceId } = req.params as { workspaceId: string }
    const query = (req.query ?? {}) as { dir?: string }
    const dir = typeof query.dir === 'string' ? query.dir.trim().replace(/^\/+/, '') : ''
    const file = await req.file()
    if (!file) throw new AppError(RPC_ERROR_CODES.INVALID_PARAMS, 'invalid_params', 'No file uploaded')
    const buf = await file.toBuffer()
    const safeName = path.basename(file.filename || 'upload.bin')
    const relPath = dir ? `${dir}/${safeName}` : safeName
    return deps.workspaces.writeBinaryFile(workspaceId, relPath, buf)
  })

  fastify.get('/api/workspaces/:workspaceId/download', async (req, reply) => {
    requireAuth(req)
    const { workspaceId } = req.params as { workspaceId: string }
    const query = (req.query ?? {}) as { path?: string }
    if (!query.path) throw new AppError(RPC_ERROR_CODES.INVALID_PARAMS, 'invalid_params', 'Missing path query')
    const ws = deps.workspaces.get(workspaceId)
    const abs = resolveContainedPath(ws.rootPath, query.path)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new AppError(RPC_ERROR_CODES.NOT_FOUND, 'not_found', 'File not found')
    }
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(abs))}"`)
    return reply.send(createReadStream(abs))
  })

  // Attachment Blob upload & download (T-101)
  fastify.post('/api/blobs/upload', async (req) => {
    requireAuth(req)
    if (!deps.blobs) {
      throw new AppError(RPC_ERROR_CODES.METHOD_NOT_FOUND, 'method_not_found', 'Blob storage service not configured')
    }
    const file = await req.file()
    if (!file) throw new AppError(RPC_ERROR_CODES.INVALID_PARAMS, 'invalid_params', 'No file uploaded')
    const buffer = await file.toBuffer()
    return deps.blobs.storeBuffer({
      filename: file.filename || 'attachment.bin',
      mime: file.mimetype || 'application/octet-stream',
      buffer
    })
  })

  const SAFE_INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  fastify.get('/api/blobs/:fileId', async (req, reply) => {
    requireAuth(req)
    if (!deps.blobs) {
      throw new AppError(RPC_ERROR_CODES.METHOD_NOT_FOUND, 'method_not_found', 'Blob storage service not configured')
    }
    const { fileId } = req.params as { fileId: string }
    const query = (req.query ?? {}) as { download?: string }
    const meta = deps.blobs.getFileMeta(fileId)
    if (!existsSync(meta.absPath) || !statSync(meta.absPath).isFile()) {
      throw new AppError(RPC_ERROR_CODES.NOT_FOUND, 'not_found', 'Attachment blob missing from disk')
    }
    const allowInline = query.download !== '1' && SAFE_INLINE_IMAGES.has(meta.mime)
    const disp = allowInline ? 'inline' : 'attachment'
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Type', meta.mime)
    reply.header('Content-Disposition', `${disp}; filename="${encodeURIComponent(meta.filename)}"`)
    return reply.send(createReadStream(meta.absPath))
  })

  // Encapsulated Webhook raw-body capture scope (leaves /api JSON parser untouched)
  await fastify.register(
    async (webhookApp) => {
      const captureRaw = (_req: unknown, body: Buffer, done: (err: Error | null, body?: Buffer) => void) => {
        done(null, body)
      }
      webhookApp.addContentTypeParser('application/json', { parseAs: 'buffer' }, captureRaw)
      webhookApp.addContentTypeParser('*', { parseAs: 'buffer' }, captureRaw)

      webhookApp.post('/generic/:hookId', async (req) => {
        if (!deps.onGenericWebhook) {
          throw new AppError(RPC_ERROR_CODES.METHOD_NOT_FOUND, 'method_not_found', 'Webhook handler not registered')
        }
        const { hookId } = req.params as { hookId: string }
        const headers = normalizeHeaders(req.headers)
        const query = (req.query ?? {}) as { secret?: string }
        const authBearer = /^bearer\s+(.+)$/i.exec(headers['authorization'] || '')?.[1]?.trim() || ''
        const secret =
          headers['x-webhook-secret'] || authBearer || (typeof query.secret === 'string' ? query.secret : '')
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8')
        return await deps.onGenericWebhook(hookId, secret, { headers, rawBody })
      })

      webhookApp.post('/:pluginId/:instanceId', async (req) => {
        if (!deps.onPluginWebhook) {
          throw new AppError(RPC_ERROR_CODES.METHOD_NOT_FOUND, 'method_not_found', 'Plugin webhook handler not registered')
        }
        const { pluginId, instanceId } = req.params as { pluginId: string; instanceId: string }
        const headers = normalizeHeaders(req.headers)
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8')
        return await deps.onPluginWebhook(pluginId, instanceId, { headers, rawBody })
      })
    },
    { prefix: '/webhooks' }
  )

  // Static Web SPA hosting in production mode (when packages/web/dist exists)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const webDist = path.resolve(here, '../../../web/dist')
  if (existsSync(webDist)) {
    await fastify.register(fastifyStatic, { root: webDist, prefix: '/' })
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/webhooks/') || req.url.startsWith('/ws/')) {
        return reply.status(404).send({ error: 'not_found', message: 'Route not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  // WebSocket Servers (shared HTTP server upgrade handler)
  const rpcWss = new WebSocketServer({ noServer: true })
  const termWss = new WebSocketServer({ noServer: true })

  rpcWss.on('connection', (ws: WebSocket, _req: IncomingMessage, actorUsername: string) => {
    rpcClients.add(ws)
    ws.on('close', () => rpcClients.delete(ws))
    ws.on('error', () => rpcClients.delete(ws))
    ws.on('message', async (raw: RawData) => {
      let json: unknown
      try {
        json = JSON.parse(raw.toString('utf8'))
      } catch {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' }
          })
        )
        return
      }
      const parsed = JsonRpcRequestSchema.safeParse(json)
      if (!parsed.success) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid JSON-RPC request' }
          })
        )
        return
      }
      const response = await deps.rpcRouter.dispatch(parsed.data, actorUsername)
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response))
    })
  })

  termWss.on('connection', async (ws: WebSocket, _req: IncomingMessage, terminalId: string) => {
    let unsub: (() => void) | null = null
    try {
      const attach = await deps.terminals.attach(terminalId)
      if (ws.readyState === ws.OPEN && attach.buffer) {
        ws.send(JSON.stringify({ type: 'data', data: attach.buffer }))
      }
      if (attach.exited && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode: attach.exitCode }))
      }
      unsub = deps.terminals.subscribe(terminalId, (ev) => {
        if (ws.readyState !== ws.OPEN) return
        if (ev.event === 'data') ws.send(JSON.stringify({ type: 'data', data: ev.data }))
        else if (ev.event === 'exit') ws.send(JSON.stringify({ type: 'exit', exitCode: ev.exitCode }))
      })
    } catch (err) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
        ws.close(1011)
      }
      return
    }

    ws.on('message', async (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as { type?: string; data?: string; cols?: number; rows?: number }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          await deps.terminals.write(terminalId, msg.data)
        } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          await deps.terminals.resize(terminalId, msg.cols, msg.rows)
        }
      } catch {
        // ignore malformed terminal frame
      }
    })

    const cleanup = () => {
      unsub?.()
      unsub = null
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  fastify.server.on('upgrade', async (req, socket, head) => {
    const urlPath = (req.url || '').split('?')[0] || ''
    const authRes = await deps.auth.authorize({
      token: extractRequestToken(req.headers),
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      host: typeof req.headers.host === 'string' ? req.headers.host : undefined
    })

    if (!authRes.allowed) {
      socket.write(`HTTP/1.1 ${authRes.code === 'forbidden' ? '403 Forbidden' : '401 Unauthorized'}\r\n\r\n`)
      socket.destroy()
      return
    }

    if (urlPath === '/rpc') {
      rpcWss.handleUpgrade(req, socket, head, (ws) => {
        rpcWss.emit('connection', ws, req, authRes.actor.username)
      })
      return
    }

    const termMatch = /^\/ws\/terminal\/([^/]+)$/.exec(urlPath)
    if (termMatch?.[1]) {
      const terminalId = decodeURIComponent(termMatch[1])
      termWss.handleUpgrade(req, socket, head, (ws) => {
        termWss.emit('connection', ws, req, terminalId)
      })
      return
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  })

  return {
    fastify,
    broadcast,
    async listen(host, port) {
      await fastify.listen({ host, port })
    },
    async close() {
      for (const ws of rpcClients) ws.close()
      rpcWss.close()
      termWss.close()
      await fastify.close()
    }
  }
}
