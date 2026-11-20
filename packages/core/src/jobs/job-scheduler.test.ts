import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { SourcePlugin } from '@myagents/plugin-sdk'
import type { DaemonClient } from '../daemon-client'
import { InboxService } from '../inbox/inbox-service'
import { PluginManager } from '../inbox/plugin-manager'
import { DefaultSecretProvider } from '../security/hooks'
import { CollabEngine } from '../collab/collab-engine'
import { AgentService } from '../runtime/agent-service'
import type { AgentDriver, TurnOutput } from '../runtime/driver'
import { AgentEnvironmentIsolator } from '../runtime/environment-isolator'
import { CoreDatabase } from '../storage/database'
import { WorkspaceService } from '../workspace/workspace-service'
import { computeNextCronRun, parseCronExpression } from './cron'
import { registerBuiltInJobHandlers } from './builtin-handlers'
import { JobSchedulerService } from './job-scheduler'

let tmpDir: string
const prevHome = process.env.MYAGENTS_HOME

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-jobs-'))
  process.env.MYAGENTS_HOME = path.join(tmpDir, 'home')
  mkdirSync(process.env.MYAGENTS_HOME, { recursive: true })
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.MYAGENTS_HOME
  else process.env.MYAGENTS_HOME = prevHome
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Cron parser', () => {
  it('parses wildcards, steps, ranges, lists, and Sunday alias 7->0', () => {
    const parsed = parseCronExpression('*/15 9-17 1,15 * 7')
    expect([...parsed.minutes]).toEqual([0, 15, 30, 45])
    expect([...parsed.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...parsed.daysOfMonth]).toEqual([1, 15])
    expect([...parsed.daysOfWeek]).toEqual([0])

    const base = new Date(2026, 0, 1, 10, 14, 20, 0).getTime()
    const next = computeNextCronRun('*/15 * * * *', base)
    const nextDate = new Date(next)
    expect(nextDate.getMinutes()).toBe(15)
    expect(nextDate.getHours()).toBe(10)

    expect(() => parseCronExpression('* * *')).toThrow()
    expect(() => parseCronExpression('61 * * * *')).toThrow()
    expect(() => parseCronExpression('0 0 31 2 *')).toThrow()
  })
})

describe('JobSchedulerService & built-in handlers', () => {
  it('enforces idempotency, retries with exponential backoff, recovers running jobs, and avoids duplicate schedule ticks', async () => {
    const db = new CoreDatabase(':memory:')
    const scheduler = new JobSchedulerService(db, {
      pollIntervalMs: 60_000,
      baseBackoffMs: 100,
      maxRetries: 2
    })

    const j1 = scheduler.enqueueJob({
      jobType: 'routine_tick',
      payload: { marker: 1 },
      idempotencyKey: 'dedup-1'
    })
    const j2 = scheduler.enqueueJob({
      jobType: 'routine_tick',
      payload: { marker: 2 },
      idempotencyKey: 'dedup-1'
    })
    expect(j2.id).toBe(j1.id)

    let calls = 0
    scheduler.registerHandler('routine_tick', async () => {
      calls += 1
      if (calls <= 2) throw new Error('transient failure')
    })

    // First failure -> retryCount = 1
    await scheduler.tick(Date.now())
    let state = scheduler.getJob(j1.id)
    expect(state.status).toBe('pending')
    expect(state.retryCount).toBe(1)

    // Advance past backoff -> second failure -> retryCount = 2
    await scheduler.tick(state.runAfter + 10)
    state = scheduler.getJob(j1.id)
    expect(state.status).toBe('pending')
    expect(state.retryCount).toBe(2)

    // Third attempt succeeds
    await scheduler.tick(state.runAfter + 10)
    state = scheduler.getJob(j1.id)
    expect(state.status).toBe('completed')

    // Terminal failure updates linked schedule lastError
    const sched = scheduler.saveSchedule(
      {
        name: 'AlwaysFails',
        jobType: 'backup_snapshot',
        cronExpr: '* * * * *',
        payload: {}
      },
      1_000_000
    )
    scheduler.registerHandler('backup_snapshot', async () => {
      throw new Error('disk full')
    })

    const dueAt = sched.nextRunAt
    await scheduler.tick(dueAt)
    // Duplicate tick before next due time must not enqueue a second job
    await scheduler.tick(dueAt + 10)
    const jobsAfterMaterialize = scheduler.listJobs().filter((j) => j.jobType === 'backup_snapshot')
    expect(jobsAfterMaterialize).toHaveLength(1)

    let failingJob = jobsAfterMaterialize[0]!
    await scheduler.tick(failingJob.runAfter + 10)
    failingJob = scheduler.getJob(failingJob.id)
    await scheduler.tick(failingJob.runAfter + 10)
    failingJob = scheduler.getJob(failingJob.id)
    expect(failingJob.status).toBe('failed')
    expect(failingJob.errorText).toContain('disk full')
    expect(scheduler.getSchedule(sched.id).lastError).toContain('disk full')

    // Startup crash recovery resets running jobs to pending
    db.db.prepare("UPDATE background_jobs SET status = 'running' WHERE id = ?").run(failingJob.id)
    scheduler.start()
    await scheduler.stop()
    expect(scheduler.getJob(failingJob.id).status).not.toBe('running')
    db.close()
  })

  it('executes sync_source, routine_tick, and backup_snapshot handlers end-to-end', async () => {
    const dbPath = path.join(tmpDir, 'scheduler-e2e.db')
    const backupDir = path.join(tmpDir, 'backups')
    mkdirSync(backupDir, { recursive: true })

    const db = new CoreDatabase(dbPath)
    const workspaces = new WorkspaceService(db)
    const agents = new AgentService(db, workspaces)
    const plugins = new PluginManager(db, new DefaultSecretProvider())
    const isolator = new AgentEnvironmentIsolator()
    const collab = new CollabEngine(db, agents, workspaces, isolator, {} as DaemonClient, {
      roomUpdated: () => {},
      roomDeleted: () => {},
      messageCreated: () => {},
      streamDelta: () => {},
      workNodeUpdated: () => {}
    })

    const seenInstructions: Array<{ instruction: string; mode: string }> = []
    const stubDriver: AgentDriver = {
      kind: 'codex',
      capabilities: {
        supportsNativeResume: false,
        supportsSteerWhileRunning: false,
        supportsReadOnlyEnforcement: true,
        supportsDynamicMcp: true,
        supportsSubagentBlock: true
      },
      async runTurn(input): Promise<TurnOutput> {
        seenInstructions.push({ instruction: input.instruction, mode: input.workspaceMode })
        return { finalText: 'Routine completed cleanly.' }
      }
    }
    collab.registerDriver(stubDriver)
    await collab.reconcile([])

    const inbox = new InboxService(db, collab, agents, plugins)

    const pullPlugin: SourcePlugin<{ tag: string }> = {
      id: 'mock-pull',
      name: 'Mock Pull Source',
      configSchema: z.object({ tag: z.string() }),
      async pull(ctx) {
        return {
          envelopes: [
            {
              id: 'env-1',
              source: 'mock-pull',
              externalKey: `ext-${ctx.config.tag}`,
              authorName: 'cron-bot',
              title: 'Pulled Issue',
              content: 'Investigate alert',
              attachments: []
            }
          ],
          nextCursor: 'cur-2'
        }
      }
    }
    plugins.register(pullPlugin)
    const inst = plugins.configureInstance({
      pluginId: 'mock-pull',
      name: 'PullInstance',
      config: { tag: 'v1' },
      enabled: true
    })

    const agent = agents.create({
      name: 'RoutineBot',
      bio: '',
      systemPrompt: '',
      driverKind: 'codex',
      providerId: null,
      driverConfig: {},
      permissionMode: 'workspace-write',
      isolationMode: 'standard',
      skillIds: [],
      mcpServerIds: []
    })

    const scheduler = new JobSchedulerService(db, { pollIntervalMs: 60_000, maxRetries: 1 })
    registerBuiltInJobHandlers({
      scheduler,
      database: db,
      dbPath,
      inbox,
      plugins,
      collab,
      agents
    })

    // 1. sync_source
    const syncJob = scheduler.enqueueJob({
      jobType: 'sync_source',
      payload: { instanceId: inst.id }
    })
    await scheduler.tick(Date.now() + 1)
    expect(scheduler.getJob(syncJob.id).status).toBe('completed')
    const items = inbox.listItems()
    expect(items.some((i) => i.externalKey === 'ext-v1')).toBe(true)

    // 2. routine_tick (defaults to read-only)
    const routineJob = scheduler.enqueueJob({
      jobType: 'routine_tick',
      payload: { agentId: agent.id, prompt: 'Check health status' }
    })
    await scheduler.tick(Date.now() + 1)
    expect(scheduler.getJob(routineJob.id).status).toBe('completed')
    await new Promise((r) => setTimeout(r, 80))
    expect(seenInstructions).toEqual([{ instruction: 'Check health status', mode: 'read-only' }])

    // 3. backup_snapshot + retention pruning (retentionCount=2 across 3 runs)
    for (let i = 0; i < 3; i++) {
      const bj = scheduler.enqueueJob({
        jobType: 'backup_snapshot',
        payload: { targetDir: backupDir, retentionCount: 2 }
      })
      await scheduler.tick(Date.now() + 1)
      expect(scheduler.getJob(bj.id).status).toBe('completed')
      await new Promise((r) => setTimeout(r, 10))
    }

    const backups = readdirSync(backupDir).filter((f) => f.endsWith('.db'))
    expect(backups).toHaveLength(2)
    const snapshotDb = new DatabaseSync(path.join(backupDir, backups[0]!), { readOnly: true })
    const row = snapshotDb.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    expect(row.c).toBe(1)
    snapshotDb.close()

    await scheduler.stop()
    db.close()
  })
})
