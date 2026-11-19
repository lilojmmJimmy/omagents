import { randomUUID } from 'node:crypto'
import type { TerminalSession } from '@myagents/protocol'
import type { AttachResult, DaemonEvent, SessionInfo } from '@myagents/protocol/node'
import type { DaemonClient } from '../daemon-client'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'
import type { WorkspaceService } from './workspace-service'

interface TerminalRow {
  id: string
  workspace_id: string
  daemon_session_id: string
  title: string
  status: 'running' | 'exited'
  exit_code: number | null
  created_at: number
  updated_at: number
}

function mapTerminal(row: TerminalRow): TerminalSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    daemonSessionId: row.daemon_session_id,
    title: row.title,
    status: row.status,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoLogo'] }
  }
  return { command: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

export class TerminalService {
  private readonly subscribers = new Map<string, Set<(event: DaemonEvent) => void>>()

  constructor(
    private readonly database: CoreDatabase,
    private readonly daemon: DaemonClient,
    private readonly workspaces: WorkspaceService
  ) {
    this.daemon.onEvent((event) => this.handleDaemonEvent(event))
  }

  private handleDaemonEvent(event: DaemonEvent): void {
    const row = this.database.db
      .prepare('SELECT * FROM terminal_sessions WHERE daemon_session_id = ?')
      .get(event.sessionId) as unknown as TerminalRow | undefined
    if (!row) return

    if (event.event === 'exit') {
      this.database.db
        .prepare('UPDATE terminal_sessions SET status = ?, exit_code = ?, updated_at = ? WHERE id = ?')
        .run('exited', event.exitCode, Date.now(), row.id)
    }

    const subs = this.subscribers.get(row.id)
    if (subs) {
      for (const fn of subs) fn(event)
    }
  }

  reconcile(liveDaemonSessions: SessionInfo[]): void {
    const liveMap = new Map(liveDaemonSessions.map((s) => [s.sessionId, s]))
    const rows = this.database.db
      .prepare("SELECT * FROM terminal_sessions WHERE status = 'running'")
      .all() as unknown as TerminalRow[]
    const now = Date.now()
    for (const row of rows) {
      const live = liveMap.get(row.daemon_session_id)
      if (!live) {
        this.database.db
          .prepare("UPDATE terminal_sessions SET status = 'exited', exit_code = -1, updated_at = ? WHERE id = ?")
          .run(now, row.id)
      } else if (live.exited) {
        this.database.db
          .prepare("UPDATE terminal_sessions SET status = 'exited', exit_code = ?, updated_at = ? WHERE id = ?")
          .run(live.exitCode, now, row.id)
      }
    }
  }

  list(workspaceId?: string): TerminalSession[] {
    const rows = workspaceId
      ? (this.database.db
          .prepare('SELECT * FROM terminal_sessions WHERE workspace_id = ? ORDER BY created_at DESC')
          .all(workspaceId) as unknown as TerminalRow[])
      : (this.database.db
          .prepare('SELECT * FROM terminal_sessions ORDER BY created_at DESC')
          .all() as unknown as TerminalRow[])
    return rows.map(mapTerminal)
  }

  get(id: string): TerminalSession {
    const row = this.database.db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id) as unknown as TerminalRow | undefined
    if (!row) throw Errors.notFound(`Terminal session not found: ${id}`)
    return mapTerminal(row)
  }

  async open(workspaceId: string, cols = 100, rows = 30): Promise<TerminalSession> {
    const ws = this.workspaces.get(workspaceId)
    const { command, args } = defaultShell()
    const id = randomUUID()
    const daemonSessionId = `pty-${id}`
    await this.daemon.call('spawnPty', {
      sessionId: daemonSessionId,
      command,
      args,
      cwd: ws.rootPath,
      env: {},
      cols: Math.max(20, cols),
      rows: Math.max(5, rows)
    })

    const now = Date.now()
    this.database.db
      .prepare(
        `INSERT INTO terminal_sessions (id, workspace_id, daemon_session_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`
      )
      .run(id, ws.id, daemonSessionId, `${ws.name} Shell`, now, now)
    return this.get(id)
  }

  async attach(terminalId: string): Promise<AttachResult> {
    const t = this.get(terminalId)
    return await this.daemon.call('attach', { sessionId: t.daemonSessionId })
  }

  async write(terminalId: string, data: string): Promise<void> {
    const t = this.get(terminalId)
    await this.daemon.call('write', { sessionId: t.daemonSessionId, data })
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const t = this.get(terminalId)
    await this.daemon.call('resize', { sessionId: t.daemonSessionId, cols: Math.max(20, cols), rows: Math.max(5, rows) })
  }

  async close(terminalId: string): Promise<void> {
    const t = this.get(terminalId)
    try {
      await this.daemon.call('release', { sessionId: t.daemonSessionId })
    } catch {
      // already gone
    }
    this.database.db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(terminalId)
  }

  subscribe(terminalId: string, listener: (event: DaemonEvent) => void): () => void {
    let set = this.subscribers.get(terminalId)
    if (!set) {
      set = new Set()
      this.subscribers.set(terminalId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) this.subscribers.delete(terminalId)
    }
  }
}
