import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { AuthGuard, RequestContext } from '@myagents/protocol'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE_NAME = 'myagents_sid'

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `scrypt:${salt}:${derived}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, expectedHex] = parts
  if (!salt || !expectedHex) return false
  const derived = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

function sha256(val: string): string {
  return createHash('sha256').update(val).digest('hex')
}

export function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!cookieHeader) return result
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const k = pair.slice(0, idx).trim()
    const v = pair.slice(idx + 1).trim()
    if (k) result[k] = decodeURIComponent(v)
  }
  return result
}

export class AuthService implements AuthGuard {
  constructor(private readonly database: CoreDatabase) {
    this.ensureDefaultAccount()
  }

  private ensureDefaultAccount(): void {
    const existing = this.database.db.prepare('SELECT id FROM auth_config WHERE id = ?').get('default')
    if (existing) return
    const username = process.env.MYAGENTS_ADMIN_USER?.trim() || 'admin'
    const password = process.env.MYAGENTS_ADMIN_PASS ?? 'admin'
    const isDefault = username === 'admin' && password === 'admin' ? 1 : 0
    this.database.db
      .prepare(
        'INSERT INTO auth_config (id, username, password_hash, is_default_password, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('default', username, hashPassword(password), isDefault, Date.now())
  }

  isDefaultPassword(): boolean {
    const row = this.database.db.prepare('SELECT is_default_password FROM auth_config WHERE id = ?').get('default') as
      | { is_default_password: number }
      | undefined
    return Boolean(row?.is_default_password)
  }

  login(username: string, password: string): { token: string; username: string; expiresAt: number } {
    const row = this.database.db
      .prepare('SELECT username, password_hash FROM auth_config WHERE id = ?')
      .get('default') as { username: string; password_hash: string } | undefined
    if (!row || row.username !== username.trim() || !verifyPassword(password, row.password_hash)) {
      throw Errors.unauthorized('Invalid username or password')
    }
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    const expiresAt = now + SESSION_TTL_MS
    this.database.db
      .prepare(
        'INSERT INTO auth_sessions (token_hash, username, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(sha256(token), row.username, expiresAt, now, now)
    this.pruneExpired()
    return { token, username: row.username, expiresAt }
  }

  logout(token?: string): void {
    if (!token) return
    this.database.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token))
  }

  changePassword(currentToken: string, oldPassword: string, newPassword: string): void {
    if (newPassword.length < 4) throw Errors.invalidParams('New password must be at least 4 characters')
    const row = this.database.db.prepare('SELECT password_hash FROM auth_config WHERE id = ?').get('default') as
      | { password_hash: string }
      | undefined
    if (!row || !verifyPassword(oldPassword, row.password_hash)) {
      throw Errors.unauthorized('Current password is incorrect')
    }
    const now = Date.now()
    const currentHash = sha256(currentToken)
    this.database.transaction(() => {
      this.database.db
        .prepare('UPDATE auth_config SET password_hash = ?, is_default_password = 0, updated_at = ? WHERE id = ?')
        .run(hashPassword(newPassword), now, 'default')
      this.database.db.prepare('DELETE FROM auth_sessions WHERE token_hash != ?').run(currentHash)
    })
  }

  extractToken(ctx: RequestContext): string | undefined {
    if (ctx.token) return ctx.token
    if (ctx.cookie) {
      const cookies = parseCookieHeader(ctx.cookie)
      if (cookies[SESSION_COOKIE_NAME]) return cookies[SESSION_COOKIE_NAME]
    }
    return undefined
  }

  verifySession(token?: string): { username: string } | null {
    if (!token) return null
    const tokenHash = sha256(token)
    const now = Date.now()
    const row = this.database.db
      .prepare('SELECT username, expires_at FROM auth_sessions WHERE token_hash = ?')
      .get(tokenHash) as { username: string; expires_at: number } | undefined
    if (!row) return null
    if (row.expires_at < now) {
      this.database.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
      return null
    }
    // Sliding refresh every 5 minutes
    this.database.db
      .prepare('UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?')
      .run(now, now + SESSION_TTL_MS, tokenHash)
    return { username: row.username }
  }

  isOriginAllowed(origin?: string, host?: string): boolean {
    if (!origin) return true // Non-browser clients (curl/scripts) have no Origin header
    if (!host) return false
    try {
      const url = new URL(origin)
      return url.host.toLowerCase() === host.toLowerCase()
    } catch {
      return false
    }
  }

  async authorize(ctx: RequestContext): Promise<{
    allowed: boolean
    actor: { kind: 'human'; id: string; username: string }
    code?: 'unauthorized' | 'forbidden'
    reason?: string
  }> {
    if (ctx.origin && !this.isOriginAllowed(ctx.origin, ctx.host)) {
      return {
        allowed: false,
        actor: { kind: 'human', id: 'anonymous', username: 'anonymous' },
        code: 'forbidden',
        reason: 'Cross-origin WebSocket rejected'
      }
    }
    const session = this.verifySession(this.extractToken(ctx))
    if (!session) {
      return {
        allowed: false,
        actor: { kind: 'human', id: 'anonymous', username: 'anonymous' },
        code: 'unauthorized',
        reason: 'Authentication required'
      }
    }
    return {
      allowed: true,
      actor: { kind: 'human', id: session.username, username: session.username }
    }
  }

  private pruneExpired(): void {
    this.database.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now())
  }
}
