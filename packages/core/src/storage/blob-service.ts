import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BlobPurgeResult, BlobStorageSummary, FileRef } from '@myagents/protocol'
import { myagentsBlobsDir } from '@myagents/protocol/node'
import { Errors } from '../errors'
import { resolveContainedPath } from '../workspace/path-guard'
import type { CoreDatabase } from './database'

const DEFAULT_MAX_BLOB_BYTES = 50 * 1024 * 1024
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.cfg',
  '.env',
  '.log',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.cs',
  '.sh',
  '.ps1',
  '.sql',
  '.diff',
  '.patch'
])

const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-sh'
])

interface FileRow {
  id: string
  sha256: string
  filename: string
  mime: string
  size_bytes: number
  storage_key: string
  backend_kind: string
  created_at: number
}

interface OutboxRow {
  id: string
  sha256: string
  storage_key: string
  backend_kind: string
  retry_count: number
  last_error: string | null
  created_at: number
}

export interface BlobMeta {
  id: string
  sha256: string
  filename: string
  mime: string
  sizeBytes: number
  storageKey: string
  absPath: string
  createdAt: number
}

function sanitizeFilename(raw: string): string {
  const base = path.basename(raw || 'attachment.bin').replace(/[\r\n\0/\\]/g, '_').trim()
  return (base || 'attachment.bin').slice(0, 255)
}

function normalizeMime(raw?: string): string {
  const clean = (raw || '').split(';')[0]?.trim().toLowerCase()
  return clean || 'application/octet-stream'
}

function isTextLike(filename: string, mime: string): boolean {
  if (mime.startsWith('text/')) return true
  if (TEXT_MIME_EXACT.has(mime)) return true
  const ext = path.extname(filename).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

function mapFileRef(row: Pick<FileRow, 'id' | 'filename' | 'mime' | 'size_bytes'>): FileRef {
  return {
    fileId: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.size_bytes
  }
}

export class BlobService {
  constructor(private readonly database: CoreDatabase) {}

  private ensureBlobsRoot(): string {
    const dir = myagentsBlobsDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  storeBuffer(input: {
    filename: string
    mime?: string
    buffer: Buffer
    maxBytes?: number
  }): FileRef {
    const limit = input.maxBytes ?? DEFAULT_MAX_BLOB_BYTES
    if (input.buffer.byteLength > limit) {
      throw Errors.invalidParams(`Attachment exceeds ${Math.round(limit / (1024 * 1024))}MB limit`)
    }

    const filename = sanitizeFilename(input.filename)
    const mime = normalizeMime(input.mime)
    const sha256 = createHash('sha256').update(input.buffer).digest('hex')
    const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`
    const blobsRoot = this.ensureBlobsRoot()
    const absPath = resolveContainedPath(blobsRoot, storageKey)

    if (!existsSync(absPath)) {
      mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 })
      const tmpPath = `${absPath}.tmp-${randomUUID()}`
      writeFileSync(tmpPath, input.buffer, { mode: 0o600 })
      if (!existsSync(absPath)) {
        renameSync(tmpPath, absPath)
      } else {
        rmSync(tmpPath, { force: true })
      }
    }

    const id = randomUUID()
    const now = Date.now()
    this.database.db
      .prepare(
        `INSERT INTO files (id, sha256, filename, mime, size_bytes, storage_key, backend_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'local', ?)`
      )
      .run(id, sha256, filename, mime, input.buffer.byteLength, storageKey, now)

    return { fileId: id, filename, mime, sizeBytes: input.buffer.byteLength }
  }

  getFileMeta(fileId: string): BlobMeta {
    const row = this.database.db
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(fileId) as unknown as FileRow | undefined
    if (!row) {
      throw Errors.notFound(`Attachment file not found: ${fileId}`)
    }
    const absPath = resolveContainedPath(this.ensureBlobsRoot(), row.storage_key)
    return {
      id: row.id,
      sha256: row.sha256,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.size_bytes,
      storageKey: row.storage_key,
      absPath,
      createdAt: row.created_at
    }
  }

  resolveRefs(fileIds: readonly string[]): FileRef[] {
    const unique = [...new Set(fileIds.map((id) => id.trim()).filter(Boolean))]
    if (unique.length === 0) return []
    const refs: FileRef[] = []
    const stmt = this.database.db.prepare('SELECT id, filename, mime, size_bytes FROM files WHERE id = ?')
    for (const id of unique) {
      const row = stmt.get(id) as unknown as Pick<FileRow, 'id' | 'filename' | 'mime' | 'size_bytes'> | undefined
      if (!row) {
        throw Errors.notFound(`Attachment file not found: ${id}`)
      }
      refs.push(mapFileRef(row))
    }
    return refs
  }

  readTextPreview(fileId: string, maxChars = 8_000): string | null {
    const meta = this.getFileMeta(fileId)
    if (meta.sizeBytes > TEXT_PREVIEW_MAX_BYTES || !isTextLike(meta.filename, meta.mime)) {
      return null
    }
    if (!existsSync(meta.absPath)) return null
    const buf = readFileSync(meta.absPath)
    if (buf.includes(0)) return null
    const text = buf.toString('utf8')
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}\n... [truncated at ${maxChars} chars]`
  }

  attachRefs(
    fileIds: readonly string[],
    ownerType: 'message' | 'inbox' | 'room',
    ownerId: string
  ): FileRef[] {
    const unique = [...new Set(fileIds.map((id) => id.trim()).filter(Boolean))]
    if (unique.length === 0) return []

    const refs: FileRef[] = []
    const now = Date.now()
    const selectStmt = this.database.db.prepare(
      'SELECT id, sha256, filename, mime, size_bytes FROM files WHERE id = ?'
    )
    const insertRefStmt = this.database.db.prepare(
      'INSERT OR IGNORE INTO file_refs (file_id, owner_type, owner_id, created_at) VALUES (?, ?, ?, ?)'
    )
    const clearOutboxStmt = this.database.db.prepare('DELETE FROM file_deletion_outbox WHERE sha256 = ?')

    for (const id of unique) {
      const row = selectStmt.get(id) as unknown as
        | Pick<FileRow, 'id' | 'sha256' | 'filename' | 'mime' | 'size_bytes'>
        | undefined
      if (!row) {
        throw Errors.notFound(`Attachment file not found: ${id}`)
      }
      insertRefStmt.run(row.id, ownerType, ownerId, now)
      clearOutboxStmt.run(row.sha256)
      refs.push(mapFileRef(row))
    }
    return refs
  }

  releaseOwnerRefs(ownerType: 'message' | 'inbox' | 'room', ownerIds: readonly string[]): void {
    const ids = [...new Set(ownerIds.map((id) => id.trim()).filter(Boolean))]
    if (ids.length === 0) return

    this.database.transaction(() => {
      const placeholders = ids.map(() => '?').join(',')
      const affected = this.database.db
        .prepare(
          `SELECT DISTINCT f.sha256, f.storage_key, f.backend_kind
           FROM file_refs fr
           JOIN files f ON f.id = fr.file_id
           WHERE fr.owner_type = ? AND fr.owner_id IN (${placeholders})`
        )
        .all(ownerType, ...ids) as unknown as Array<Pick<FileRow, 'sha256' | 'storage_key' | 'backend_kind'>>

      this.database.db
        .prepare(`DELETE FROM file_refs WHERE owner_type = ? AND owner_id IN (${placeholders})`)
        .run(ownerType, ...ids)

      const countStmt = this.database.db.prepare(
        `SELECT COUNT(*) AS cnt
         FROM file_refs fr
         JOIN files f ON f.id = fr.file_id
         WHERE f.sha256 = ?`
      )
      const existsOutboxStmt = this.database.db.prepare(
        'SELECT id FROM file_deletion_outbox WHERE sha256 = ? LIMIT 1'
      )
      const insertOutboxStmt = this.database.db.prepare(
        `INSERT INTO file_deletion_outbox (id, sha256, storage_key, backend_kind, retry_count, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      const now = Date.now()
      for (const item of affected) {
        const refRow = countStmt.get(item.sha256) as { cnt: number }
        if (refRow.cnt === 0) {
          const dup = existsOutboxStmt.get(item.sha256) as { id: string } | undefined
          if (!dup) {
            insertOutboxStmt.run(randomUUID(), item.sha256, item.storage_key, item.backend_kind, now)
          }
        }
      }
    })
  }

  getStorageSummary(): BlobStorageSummary {
    const rows = this.database.db
      .prepare(
        `SELECT f.*, EXISTS (SELECT 1 FROM file_refs fr WHERE fr.file_id = f.id) AS has_ref
         FROM files f
         ORDER BY f.created_at DESC`
      )
      .all() as unknown as Array<FileRow & { has_ref: number }>

    const uniqueSizeBySha = new Map<string, number>()
    const referencedShas = new Set<string>()
    let referencedFiles = 0
    const unreferencedItems: BlobStorageSummary['unreferencedItems'] = []

    for (const row of rows) {
      if (!uniqueSizeBySha.has(row.sha256)) {
        uniqueSizeBySha.set(row.sha256, row.size_bytes)
      }
      if (row.has_ref) {
        referencedFiles += 1
        referencedShas.add(row.sha256)
      } else if (unreferencedItems.length < 100) {
        unreferencedItems.push({
          id: row.id,
          sha256: row.sha256,
          filename: row.filename,
          mime: row.mime,
          sizeBytes: row.size_bytes,
          createdAt: row.created_at
        })
      }
    }

    let totalBytes = 0
    let referencedBytes = 0
    let unreferencedBytes = 0
    for (const [sha, bytes] of uniqueSizeBySha) {
      totalBytes += bytes
      if (referencedShas.has(sha)) referencedBytes += bytes
      else unreferencedBytes += bytes
    }

    const outboxRow = this.database.db
      .prepare('SELECT COUNT(*) AS cnt FROM file_deletion_outbox')
      .get() as { cnt: number }

    return {
      totalFiles: rows.length,
      totalBytes,
      referencedFiles,
      referencedBytes,
      unreferencedFiles: rows.length - referencedFiles,
      unreferencedBytes,
      outboxPendingCount: outboxRow.cnt,
      unreferencedItems
    }
  }

  // Invoked only via explicit user action with confirmation; never scheduled automatically.
  purgeUnreferenced(): BlobPurgeResult {
    const candidates = new Map<string, string>()
    let deletedFileRecords = 0

    this.database.transaction(() => {
      const unrefRows = this.database.db
        .prepare(
          `SELECT f.id, f.sha256, f.storage_key
           FROM files f
           WHERE NOT EXISTS (SELECT 1 FROM file_refs fr WHERE fr.file_id = f.id)`
        )
        .all() as unknown as Array<Pick<FileRow, 'id' | 'sha256' | 'storage_key'>>

      for (const r of unrefRows) {
        candidates.set(r.sha256, r.storage_key)
      }

      const outboxRows = this.database.db
        .prepare('SELECT * FROM file_deletion_outbox')
        .all() as unknown as OutboxRow[]
      for (const o of outboxRows) {
        candidates.set(o.sha256, o.storage_key)
      }

      if (unrefRows.length > 0) {
        const res = this.database.db
          .prepare('DELETE FROM files WHERE NOT EXISTS (SELECT 1 FROM file_refs fr WHERE fr.file_id = files.id)')
          .run()
        deletedFileRecords = Number(res.changes ?? 0)
      }
    })

    let deletedPhysicalBlobs = 0
    let reclaimedBytes = 0
    const errors: string[] = []
    const blobsRoot = this.ensureBlobsRoot()
    const stillExistsStmt = this.database.db.prepare('SELECT 1 FROM files WHERE sha256 = ? LIMIT 1')
    const deleteOutboxStmt = this.database.db.prepare('DELETE FROM file_deletion_outbox WHERE sha256 = ?')
    const failOutboxStmt = this.database.db.prepare(
      'UPDATE file_deletion_outbox SET retry_count = retry_count + 1, last_error = ? WHERE sha256 = ?'
    )

    for (const [sha256, storageKey] of candidates) {
      const remaining = stillExistsStmt.get(sha256)
      if (remaining) {
        deleteOutboxStmt.run(sha256)
        continue
      }

      try {
        const absPath = resolveContainedPath(blobsRoot, storageKey)
        if (existsSync(absPath)) {
          const size = statSync(absPath).size
          rmSync(absPath, { force: true })
          deletedPhysicalBlobs += 1
          reclaimedBytes += size
        }
        deleteOutboxStmt.run(sha256)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${sha256.slice(0, 12)}: ${msg}`)
        failOutboxStmt.run(msg.slice(0, 500), sha256)
      }
    }

    return {
      deletedFileRecords,
      deletedPhysicalBlobs,
      reclaimedBytes,
      errors
    }
  }
}
