import type { JsonRpcError, JsonRpcNotification, JsonRpcSuccess } from '@myagents/protocol'

type Pending = {
  resolve: (v: any) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RpcClient {
  private ws: WebSocket | null = null
  private reqSeq = 0
  private readonly pending = new Map<string, Pending>()
  private readonly notifListeners = new Set<(notif: JsonRpcNotification) => void>()
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private shouldConnect = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectPromise: Promise<void> | null = null

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  onNotification(fn: (notif: JsonRpcNotification) => void): () => void {
    this.notifListeners.add(fn)
    return () => this.notifListeners.delete(fn)
  }

  onStatusChange(fn: (connected: boolean) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  private emitStatus(connected: boolean): void {
    for (const fn of this.statusListeners) fn(connected)
  }

  connect(): Promise<void> {
    this.shouldConnect = true
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/rpc`)
      let opened = false

      ws.onopen = () => {
        opened = true
        this.ws = ws
        this.connectPromise = null
        this.emitStatus(true)
        resolve()
      }

      ws.onmessage = (ev) => {
        let msg: any
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg && msg.id !== undefined && msg.id !== null) {
          const p = this.pending.get(String(msg.id))
          if (!p) return
          this.pending.delete(String(msg.id))
          clearTimeout(p.timer)
          if ('error' in msg && msg.error) {
            const errObj = (msg as JsonRpcError).error
            const e = new Error(errObj.message || 'RPC Error')
            ;(e as any).code = errObj.code
            ;(e as any).reason = errObj.data?.reason
            p.reject(e)
          } else {
            p.resolve((msg as JsonRpcSuccess).result)
          }
          return
        }
        if (msg && typeof msg.method === 'string') {
          for (const fn of this.notifListeners) fn(msg as JsonRpcNotification)
        }
      }

      ws.onclose = () => {
        const wasOpen = this.ws === ws
        if (wasOpen) this.ws = null
        this.connectPromise = null
        this.emitStatus(false)
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('WebSocket disconnected'))
        }
        this.pending.clear()
        if (!opened) reject(new Error('WebSocket failed to connect'))
        if (this.shouldConnect) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
          this.reconnectTimer = setTimeout(() => {
            if (this.shouldConnect) void this.connect().catch(() => {})
          }, 1500)
        }
      }

      ws.onerror = () => {
        // handled by onclose
      }
    })

    return this.connectPromise
  }

  disconnect(): void {
    this.shouldConnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.connectPromise = null
    this.emitStatus(false)
  }

  async call<T = any>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (!this.isConnected) await this.connect()
    const id = `r-${++this.reqSeq}`
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
    })
  }
}

export const rpc = new RpcClient()

export async function apiAuthMe(): Promise<{ authenticated: boolean; username?: string; defaultPasswordWarning?: boolean }> {
  const res = await fetch('/api/auth/me')
  return (await res.json()) as any
}

export async function apiLogin(username: string, password: string): Promise<{ ok: boolean; username: string; defaultPasswordWarning?: boolean }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const data = (await res.json()) as any
  if (!res.ok) throw new Error(data?.message || 'Login failed')
  return data
}

export async function apiLogout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
}

export async function apiChangePassword(oldPassword: string, newPassword: string): Promise<void> {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword })
  })
  const data = (await res.json()) as any
  if (!res.ok) throw new Error(data?.message || 'Failed to change password')
}

export async function apiUploadWorkspaceFile(workspaceId: string, dir: string, file: File): Promise<{ path: string; size: number }> {
  const fd = new FormData()
  fd.append('file', file)
  const qs = dir ? `?dir=${encodeURIComponent(dir)}` : ''
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/upload${qs}`, {
    method: 'POST',
    body: fd
  })
  const data = (await res.json()) as any
  if (!res.ok) throw new Error(data?.message || 'Upload failed')
  return data
}
