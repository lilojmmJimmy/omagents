import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { myagentsBackupsDir } from '@myagents/protocol/node'
import type { CollabEngine } from '../collab/collab-engine'
import { Errors } from '../errors'
import type { InboxService } from '../inbox/inbox-service'
import type { PluginManager } from '../inbox/plugin-manager'
import type { AgentService } from '../runtime/agent-service'
import type { CoreDatabase } from '../storage/database'
import type { JobSchedulerService } from './job-scheduler'

export function registerBuiltInJobHandlers(deps: {
  scheduler: JobSchedulerService
  database: CoreDatabase
  dbPath: string
  inbox: InboxService
  plugins: PluginManager
  collab: CollabEngine
  agents: AgentService
}): void {
  deps.scheduler.registerHandler('sync_source', async (job) => {
    const instanceId = typeof job.payload.instanceId === 'string' ? job.payload.instanceId.trim() : ''
    if (instanceId) {
      await deps.inbox.syncPluginInstance(instanceId)
      return
    }
    const pullable = new Set(
      deps.plugins
        .listDescriptors()
        .filter((d) => d.supportsPull)
        .map((d) => d.id)
    )
    for (const inst of deps.plugins.listInstances()) {
      if (inst.enabled && pullable.has(inst.pluginId)) {
        await deps.inbox.syncPluginInstance(inst.id)
      }
    }
  })

  deps.scheduler.registerHandler('routine_tick', async (job) => {
    const prompt =
      typeof job.payload.prompt === 'string' && job.payload.prompt.trim()
        ? job.payload.prompt.trim()
        : 'Run scheduled routine check.'
    const allowWrite = job.payload.allowWrite === true
    let roomId = typeof job.payload.roomId === 'string' ? job.payload.roomId.trim() : ''

    if (!roomId) {
      const requestedAgentId = typeof job.payload.agentId === 'string' ? job.payload.agentId.trim() : ''
      const agent = requestedAgentId ? deps.agents.get(requestedAgentId) : deps.agents.list(false)[0]
      if (!agent) {
        throw Errors.invalidParams('No active agent available for routine_tick job')
      }
      const workspaceId =
        typeof job.payload.workspaceId === 'string' && job.payload.workspaceId.trim()
          ? job.payload.workspaceId.trim()
          : agent.defaultWorkspaceId
      const title =
        typeof job.payload.title === 'string' && job.payload.title.trim()
          ? job.payload.title.trim()
          : `[Routine] ${agent.name}`
      const room = await deps.collab.createRoom({
        title,
        purpose: `Scheduled routine job ${job.id}`,
        strategyId: 'single',
        primaryWorkspaceId: workspaceId,
        members: [{ agentId: agent.id, displayName: agent.name }]
      })
      roomId = room.id
    }

    await deps.collab.sendMessage(roomId, {
      content: prompt,
      authorName: 'Scheduler',
      forceReadOnly: !allowWrite,
      idempotencyKey: `job:${job.id}`
    })
  })

  deps.scheduler.registerHandler('backup_snapshot', async (job) => {
    if (deps.dbPath === ':memory:') {
      throw Errors.invalidParams('Cannot snapshot an in-memory database')
    }
    const targetDir =
      typeof job.payload.targetDir === 'string' && job.payload.targetDir.trim()
        ? path.resolve(job.payload.targetDir.trim())
        : myagentsBackupsDir()
    mkdirSync(targetDir, { recursive: true, mode: 0o700 })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const snapshotPath = path.join(targetDir, `myagents-backup-${stamp}-${job.id.slice(0, 8)}.db`)
    const escapedPath = snapshotPath.replaceAll("'", "''")
    deps.database.db.exec(`VACUUM INTO '${escapedPath}'`)

    const retentionRaw = typeof job.payload.retentionCount === 'number' ? job.payload.retentionCount : 7
    const retention = Math.min(100, Math.max(1, Math.floor(retentionRaw)))
    if (existsSync(targetDir)) {
      const backups = readdirSync(targetDir)
        .filter((f) => /^myagents-backup-.*\.db$/.test(f))
        .sort((a, b) => b.localeCompare(a))
      for (const obsolete of backups.slice(retention)) {
        rmSync(path.join(targetDir, obsolete), { force: true })
      }
    }
  })
}
