import { randomUUID } from 'node:crypto'
import type {
  BackgroundJob,
  BackgroundJobEnqueueInput,
  BackgroundJobStatus,
  BackgroundJobType,
  ScheduledJob,
  ScheduledJobSaveInput
} from '@myagents/protocol'
import { Errors } from '../errors'
import type { CoreDatabase } from '../storage/database'
import { computeNextCronRun, parseCronExpression } from './cron'

interface JobRow {
  id: string
  job_type: BackgroundJobType
  payload_json: string
  status: BackgroundJobStatus
  run_after: number
  retry_count: number
  idempotency_key: string | null
  error_text: string | null
  created_at: number
  updated_at: number
}

interface ScheduleRow {
  id: string
  name: string
  job_type: BackgroundJobType
  cron_expr: string
  payload_json: string
  enabled: number
  next_run_at: number
  last_run_at: number | null
  last_job_id: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

function mapJob(row: JobRow): BackgroundJob {
  return {
    id: row.id,
    jobType: row.job_type,
    payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    status: row.status,
    runAfter: row.run_after,
    retryCount: row.retry_count,
    idempotencyKey: row.idempotency_key,
    errorText: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapSchedule(row: ScheduleRow): ScheduledJob {
  return {
    id: row.id,
    name: row.name,
    jobType: row.job_type,
    cronExpr: row.cron_expr,
    payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastJobId: row.last_job_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export type JobHandler = (job: BackgroundJob) => Promise<void>

export class JobSchedulerService {
  private readonly handlers = new Map<BackgroundJobType, JobHandler>()
  private readonly runningPromises = new Set<Promise<void>>()
  private readonly pollIntervalMs: number
  private readonly baseBackoffMs: number
  private readonly maxRetries: number
  private readonly maxConcurrent: number
  private readonly onUpdate?: (event: { kind: 'job' | 'schedule'; id: string }) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private readonly database: CoreDatabase,
    opts?: {
      pollIntervalMs?: number
      baseBackoffMs?: number
      maxRetries?: number
      maxConcurrent?: number
      onUpdate?: (event: { kind: 'job' | 'schedule'; id: string }) => void
    }
  ) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? 5_000
    this.baseBackoffMs = opts?.baseBackoffMs ?? 5_000
    this.maxRetries = opts?.maxRetries ?? 3
    this.maxConcurrent = opts?.maxConcurrent ?? 3
    this.onUpdate = opts?.onUpdate
  }

  registerHandler(jobType: BackgroundJobType, handler: JobHandler): void {
    this.handlers.set(jobType, handler)
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    // Requeue interrupted jobs from a prior Core shutdown or crash.
    this.database.db
      .prepare("UPDATE background_jobs SET status = 'pending', updated_at = ? WHERE status = 'running'")
      .run(Date.now())
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.runningPromises.size > 0) {
      await Promise.allSettled([...this.runningPromises])
    }
  }

  async tick(now?: number): Promise<void> {
    if (this.stopped) return
    const effectiveNow = now ?? Date.now()

    const touchedScheduleIds = this.materializeDueSchedules(effectiveNow)
    for (const sid of touchedScheduleIds) {
      this.onUpdate?.({ kind: 'schedule', id: sid })
    }

    const available = Math.max(0, this.maxConcurrent - this.runningPromises.size)
    if (available === 0) return

    const claimed = this.claimDueJobs(effectiveNow, available)
    if (claimed.length === 0) return

    const batch: Array<Promise<void>> = []
    for (const job of claimed) {
      this.onUpdate?.({ kind: 'job', id: job.id })
      const p = this.executeJob(job, now).finally(() => {
        this.runningPromises.delete(p)
      })
      this.runningPromises.add(p)
      batch.push(p)
    }
    await Promise.allSettled(batch)
  }

  listJobs(limit = 50): BackgroundJob[] {
    const cap = Math.min(200, Math.max(1, limit))
    const rows = this.database.db
      .prepare('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?')
      .all(cap) as unknown as JobRow[]
    return rows.map(mapJob)
  }

  getJob(id: string): BackgroundJob {
    const row = this.database.db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id) as unknown as
      | JobRow
      | undefined
    if (!row) throw Errors.notFound(`Background job not found: ${id}`)
    return mapJob(row)
  }

  enqueueJob(input: BackgroundJobEnqueueInput): BackgroundJob {
    if (input.idempotencyKey) {
      const existing = this.database.db
        .prepare('SELECT * FROM background_jobs WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as unknown as JobRow | undefined
      if (existing) return mapJob(existing)
    }

    const id = randomUUID()
    const now = Date.now()
    const runAfter = input.runAfter ?? now
    this.database.db
      .prepare(
        `INSERT INTO background_jobs (id, job_type, payload_json, status, run_after, retry_count, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?)`
      )
      .run(id, input.jobType, JSON.stringify(input.payload ?? {}), runAfter, input.idempotencyKey ?? null, now, now)

    this.onUpdate?.({ kind: 'job', id })
    return this.getJob(id)
  }

  retryJob(id: string): BackgroundJob {
    const existing = this.getJob(id)
    if (existing.status === 'running') {
      throw Errors.conflict('invalid_state', 'Cannot retry a running job')
    }
    const now = Date.now()
    this.database.db
      .prepare(
        "UPDATE background_jobs SET status = 'pending', run_after = ?, error_text = NULL, updated_at = ? WHERE id = ?"
      )
      .run(now, now, id)
    this.onUpdate?.({ kind: 'job', id })
    return this.getJob(id)
  }

  deleteJob(id: string): void {
    const existing = this.getJob(id)
    if (existing.status === 'running') {
      throw Errors.conflict('invalid_state', 'Cannot delete a running job')
    }
    this.database.db.prepare('DELETE FROM background_jobs WHERE id = ?').run(id)
    this.onUpdate?.({ kind: 'job', id })
  }

  listSchedules(): ScheduledJob[] {
    const rows = this.database.db
      .prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC')
      .all() as unknown as ScheduleRow[]
    return rows.map(mapSchedule)
  }

  getSchedule(id: string): ScheduledJob {
    const row = this.database.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as unknown as
      | ScheduleRow
      | undefined
    if (!row) throw Errors.notFound(`Scheduled job not found: ${id}`)
    return mapSchedule(row)
  }

  saveSchedule(input: ScheduledJobSaveInput, now = Date.now()): ScheduledJob {
    parseCronExpression(input.cronExpr)
    const nextRunAt = computeNextCronRun(input.cronExpr, now)

    if (input.id) {
      const existing = this.getSchedule(input.id)
      const dup = this.database.db
        .prepare('SELECT id FROM scheduled_jobs WHERE LOWER(name) = LOWER(?) AND id != ?')
        .get(input.name, input.id)
      if (dup) throw Errors.conflict('name_taken', `Schedule name already exists: ${input.name}`)

      const enabled = input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0
      this.database.db
        .prepare(
          `UPDATE scheduled_jobs
           SET name = ?, job_type = ?, cron_expr = ?, payload_json = ?, enabled = ?, next_run_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name,
          input.jobType,
          input.cronExpr,
          JSON.stringify(input.payload ?? {}),
          enabled,
          nextRunAt,
          now,
          input.id
        )
      this.onUpdate?.({ kind: 'schedule', id: input.id })
      return this.getSchedule(input.id)
    }

    const dup = this.database.db.prepare('SELECT id FROM scheduled_jobs WHERE LOWER(name) = LOWER(?)').get(input.name)
    if (dup) throw Errors.conflict('name_taken', `Schedule name already exists: ${input.name}`)

    const id = randomUUID()
    this.database.db
      .prepare(
        `INSERT INTO scheduled_jobs (id, name, job_type, cron_expr, payload_json, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.jobType,
        input.cronExpr,
        JSON.stringify(input.payload ?? {}),
        input.enabled === false ? 0 : 1,
        nextRunAt,
        now,
        now
      )
    this.onUpdate?.({ kind: 'schedule', id })
    return this.getSchedule(id)
  }

  deleteSchedule(id: string): void {
    const info = this.database.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id)
    if (info.changes === 0) throw Errors.notFound(`Scheduled job not found: ${id}`)
    this.onUpdate?.({ kind: 'schedule', id })
  }

  triggerScheduleNow(id: string): BackgroundJob {
    const schedule = this.getSchedule(id)
    const now = Date.now()
    const job = this.enqueueJob({
      jobType: schedule.jobType,
      payload: schedule.payload,
      runAfter: now,
      idempotencyKey: `sched-manual:${schedule.id}:${now}:${randomUUID().slice(0, 8)}`
    })
    this.database.db
      .prepare('UPDATE scheduled_jobs SET last_run_at = ?, last_job_id = ?, updated_at = ? WHERE id = ?')
      .run(now, job.id, now, schedule.id)
    this.onUpdate?.({ kind: 'schedule', id: schedule.id })
    void this.tick()
    return job
  }

  private materializeDueSchedules(now: number): string[] {
    const touched: string[] = []
    this.database.transaction(() => {
      const due = this.database.db
        .prepare('SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC')
        .all(now) as unknown as ScheduleRow[]

      for (const s of due) {
        const idempotencyKey = `sched:${s.id}:${s.next_run_at}`
        const newJobId = randomUUID()
        this.database.db
          .prepare(
            `INSERT OR IGNORE INTO background_jobs (
               id, job_type, payload_json, status, run_after, retry_count, idempotency_key, created_at, updated_at
             ) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?)`
          )
          .run(newJobId, s.job_type, s.payload_json, now, idempotencyKey, now, now)

        const actual = this.database.db
          .prepare('SELECT id FROM background_jobs WHERE idempotency_key = ?')
          .get(idempotencyKey) as { id: string } | undefined

        let nextRunAt = now + 60_000
        try {
          nextRunAt = computeNextCronRun(s.cron_expr, Math.max(now, s.next_run_at))
        } catch {
          // Keep fallback 60s advance if cron expression became invalid
        }

        this.database.db
          .prepare(
            'UPDATE scheduled_jobs SET next_run_at = ?, last_run_at = ?, last_job_id = ?, updated_at = ? WHERE id = ?'
          )
          .run(nextRunAt, now, actual?.id ?? newJobId, now, s.id)
        touched.push(s.id)
      }
    })
    return touched
  }

  private claimDueJobs(now: number, limit: number): BackgroundJob[] {
    return this.database.transaction(() => {
      const due = this.database.db
        .prepare(
          "SELECT * FROM background_jobs WHERE status = 'pending' AND run_after <= ? ORDER BY run_after ASC, created_at ASC LIMIT ?"
        )
        .all(now, limit) as unknown as JobRow[]

      const claimed: BackgroundJob[] = []
      for (const row of due) {
        const info = this.database.db
          .prepare("UPDATE background_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'")
          .run(now, row.id)
        if (info.changes > 0) {
          claimed.push(mapJob({ ...row, status: 'running', updated_at: now }))
        }
      }
      return claimed
    })
  }

  private async executeJob(job: BackgroundJob, fixedNow?: number): Promise<void> {
    try {
      const handler = this.handlers.get(job.jobType)
      if (!handler) {
        throw new Error(`No handler registered for job type: ${job.jobType}`)
      }
      await handler(job)
      const now = fixedNow ?? Date.now()
      this.database.db
        .prepare("UPDATE background_jobs SET status = 'completed', error_text = NULL, updated_at = ? WHERE id = ?")
        .run(now, job.id)
      this.database.db
        .prepare('UPDATE scheduled_jobs SET last_error = NULL, updated_at = ? WHERE last_job_id = ?')
        .run(now, job.id)
      this.onUpdate?.({ kind: 'job', id: job.id })
    } catch (err) {
      const now = fixedNow ?? Date.now()
      const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 1000)
      if (job.retryCount < this.maxRetries) {
        const nextRetry = job.retryCount + 1
        const nextRunAfter = now + this.baseBackoffMs * 2 ** job.retryCount
        this.database.db
          .prepare(
            "UPDATE background_jobs SET status = 'pending', retry_count = ?, run_after = ?, error_text = ?, updated_at = ? WHERE id = ?"
          )
          .run(nextRetry, nextRunAfter, errMsg, now, job.id)
      } else {
        this.database.db
          .prepare("UPDATE background_jobs SET status = 'failed', error_text = ?, updated_at = ? WHERE id = ?")
          .run(errMsg, now, job.id)
        this.database.db
          .prepare('UPDATE scheduled_jobs SET last_error = ?, updated_at = ? WHERE last_job_id = ?')
          .run(errMsg, now, job.id)
      }
      this.onUpdate?.({ kind: 'job', id: job.id })
    }
  }
}
