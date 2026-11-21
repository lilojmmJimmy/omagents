import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createNdjsonParser,
  DAEMON_PROTOCOL_VERSION,
  type DaemonEvent,
  DaemonEventSchema,
  type DaemonMethod,
  type DaemonParams,
  type DaemonResponseFrame,
  type DaemonResult,
  daemonEndpointPath
} from '@myagents/protocol/node'

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DaemonClient {
  private socket: net.Socket | null = null
  private connected = false
  private protocolVersion = DAEMON_PROTOCOL_VERSION
  private readonly pending = new Map<string, PendingCall>()
  private readonly listeners = new Set<(event: DaemonEvent) => void>()
  private readonly endpoint: string

  constructor(endpoint?: string) {
    this.endpoint = endpoint || process.env.MYAGENTS_DAEMON_ENDPOINT || daemonEndpointPath()
  }

  get isConnected(): boolean {
    return this.connected
  }

  get daemonProtocolVersion(): number {
    return this.protocolVersion
  }

  onEvent(listener: (event: DaemonEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async checkProtocolAndMaybeUpgrade(autoStart: boolean): Promise<boolean> {
    const info = await this.call('info', {}, 5000)
    this.protocolVersion = info.protocolVersion
    if (info.protocolVersion >= DAEMON_PROTOCOL_VERSION || !autoStart) {
      return true
    }

    const list = await this.call('list', {}, 5000)
    const activeCount = list.sessions.filter((s) => !s.exited).length
    if (activeCount > 0) {
      console.warn(
        `[daemon-client] Connected to older daemon (protocol v${info.protocolVersion} < v${DAEMON_PROTOCOL_VERSION}), keeping alive due to ${activeCount} active session(s)`
      )
      return true
    }

    if (info.pid > 0 && info.pid !== process.pid) {
      console.log(
        `[daemon-client] Upgrading idle daemon (pid=${info.pid}) from protocol v${info.protocolVersion} to v${DAEMON_PROTOCOL_VERSION}...`
      )
      this.close()
      try {
        if (process.platform === 'win32') process.kill(info.pid)
        else process.kill(info.pid, 'SIGTERM')
      } catch {
        // already exited
      }
      const waitDeadline = Date.now() + 2000
      while (Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 100))
        try {
          process.kill(info.pid, 0)
        } catch {
          break
        }
      }
      return false
    }

    return true
  }

  async connect(autoStart = true): Promise<void> {
    if (this.connected) return
    try {
      await this.tryConnect()
      if (await this.checkProtocolAndMaybeUpgrade(autoStart)) return
    } catch (err) {
      this.close()
      if (!autoStart) throw err
    }

    this.spawnDetachedDaemon()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        await this.tryConnect()
        const info = await this.call('info', {}, 5000).catch(() => null)
        if (info) this.protocolVersion = info.protocolVersion
        return
      } catch {
        // retry until daemon socket comes up
      }
    }
    throw new Error(`Failed to connect to daemon at ${this.endpoint}`)
  }

  private spawnDetachedDaemon(): void {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const daemonEntry = path.resolve(here, '../../daemon/src/main.ts')
    const tsxBin = path.resolve(here, '../../../node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, MYAGENTS_DAEMON_ENDPOINT: this.endpoint }
        })
      : spawn(tsxBin, [daemonEntry], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, MYAGENTS_DAEMON_ENDPOINT: this.endpoint }
        })
    child.unref()
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.endpoint)
      const onError = (err: Error) => {
        sock.destroy()
        reject(err)
      }
      sock.once('error', onError)
      sock.once('connect', () => {
        sock.off('error', onError)
        this.socket = sock
        this.connected = true
        const parse = createNdjsonParser((msg) => this.handleMessage(msg))
        sock.on('data', parse)
        sock.on('close', () => {
          this.connected = false
          this.socket = null
          for (const [, p] of this.pending) {
            clearTimeout(p.timer)
            p.reject(new Error('daemon-disconnected'))
          }
          this.pending.clear()
        })
        sock.on('error', () => {
          // handled by close
        })
        resolve()
      })
    })
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    if ('id' in raw && typeof (raw as { id?: unknown }).id === 'string') {
      const frame = raw as DaemonResponseFrame
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.error) pending.reject(new Error(frame.error))
      else pending.resolve(frame.result)
      return
    }
    const parsed = DaemonEventSchema.safeParse(raw)
    if (parsed.success) {
      for (const listener of this.listeners) {
        try {
          listener(parsed.data)
        } catch {
          // isolate listener errors
        }
      }
    }
  }

  async call<M extends DaemonMethod>(method: M, params: DaemonParams<M>, timeoutMs = 15_000): Promise<DaemonResult<M>> {
    if (!this.connected || !this.socket) {
      await this.connect(true)
    }
    const id = randomUUID()
    return await new Promise<DaemonResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`daemon-timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      })
      this.socket!.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
    this.connected = false
  }
}
