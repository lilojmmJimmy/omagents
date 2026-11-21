import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  createNdjsonParser,
  type DaemonEvent,
  type DaemonMethod,
  type DaemonRequestFrame,
  daemonEndpointPath,
  daemonMethods
} from '@myagents/protocol/node'
import { createSessionHost } from './session-host'

const endpoint = process.env.MYAGENTS_DAEMON_ENDPOINT || daemonEndpointPath()

function isUnixSocket(ep: string): boolean {
  return process.platform !== 'win32' && !ep.startsWith('\\\\.\\pipe\\')
}

async function checkExistingDaemon(ep: string): Promise<'alive' | 'stale' | 'absent'> {
  if (isUnixSocket(ep) && !existsSync(ep)) return 'absent'
  return await new Promise((resolve) => {
    const client = net.createConnection(ep)
    const timer = setTimeout(() => {
      client.destroy()
      resolve('alive')
    }, 800)
    client.once('connect', () => {
      clearTimeout(timer)
      client.destroy()
      resolve('alive')
    })
    client.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (err.code === 'ENOENT') resolve('absent')
      else if (err.code === 'ECONNREFUSED') resolve('stale')
      else resolve('alive')
    })
  })
}

async function main() {
  if (isUnixSocket(endpoint)) {
    mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 })
  }

  const state = await checkExistingDaemon(endpoint)
  if (state === 'alive') {
    console.log(`[daemon] already running on ${endpoint}`)
    process.exit(0)
  }
  if (state === 'stale' && isUnixSocket(endpoint)) {
    try {
      unlinkSync(endpoint)
    } catch {
      // ignore
    }
  }

  const clients = new Set<net.Socket>()
  const emit = (event: DaemonEvent) => {
    const line = `${JSON.stringify(event)}\n`
    for (const sock of clients) {
      if (!sock.destroyed && sock.writable) sock.write(line)
    }
  }

  const host = createSessionHost(emit)

  const server = net.createServer((socket) => {
    clients.add(socket)
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))

    const parse = createNdjsonParser((raw) => {
      const req = raw as Partial<DaemonRequestFrame>
      if (!req || typeof req.id !== 'string' || typeof req.method !== 'string') return
      const method = req.method as DaemonMethod
      const spec = daemonMethods[method]
      if (!spec) {
        socket.write(`${JSON.stringify({ id: req.id, error: `unknown-method: ${req.method}` })}\n`)
        return
      }
      try {
        const parsed = spec.params.parse(req.params ?? {})
        const handler = host.handlers[method] as (p: unknown) => unknown
        const result = handler(parsed)
        socket.write(`${JSON.stringify({ id: req.id, result })}\n`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        socket.write(`${JSON.stringify({ id: req.id, error: message })}\n`)
      }
    })

    socket.on('data', parse)
  })

  server.listen(endpoint, () => {
    if (isUnixSocket(endpoint)) {
      try {
        chmodSync(endpoint, 0o600)
      } catch {
        // ignore
      }
    }
    console.log(`[daemon] listening on ${endpoint} (pid=${process.pid})`)
  })

  const shutdown = () => {
    console.log('[daemon] shutting down...')
    host.killAll()
    server.close()
    if (isUnixSocket(endpoint)) {
      try {
        unlinkSync(endpoint)
      } catch {
        // ignore
      }
    }
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[daemon] fatal:', err)
  process.exit(1)
})
