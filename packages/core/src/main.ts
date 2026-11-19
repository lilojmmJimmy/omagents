import { randomBytes } from 'node:crypto'
import { coreEndpointPath, myagentsDbPath, writePrivateFileSync } from '@myagents/protocol/node'
import { CollabEngine } from './collab/collab-engine'
import { DaemonClient } from './daemon-client'
import { InboxService } from './inbox/inbox-service'
import { PluginManager } from './inbox/plugin-manager'
import { AgentService } from './runtime/agent-service'
import { BuiltinDriver } from './runtime/builtin-driver'
import { ClaudeCodeDriver } from './runtime/claude-driver'
import { AcpCliDriver, CodexCliDriver } from './runtime/cli-drivers'
import { EnvCheckService } from './runtime/env-check'
import { AgentEnvironmentIsolator } from './runtime/environment-isolator'
import { ProviderService } from './runtime/provider-service'
import { AuthService } from './security/auth-service'
import { BasicRedactor, DefaultSecretProvider, NoopApprovalGate } from './security/hooks'
import { CoreDatabase } from './storage/database'
import { createCoreHttpServer, type CoreHttpServer } from './transport/http-server'
import { RpcRouter } from './transport/rpc-router'
import { GitService } from './workspace/git-service'
import { TerminalService } from './workspace/terminal-service'
import { WorkspaceService } from './workspace/workspace-service'

export interface CoreRuntimeOptions {
  host?: string
  port?: number
  dbPath?: string
  daemonEndpoint?: string
  autoStartDaemon?: boolean
  writeCoreEndpoint?: boolean
}

export async function startCoreServer(opts: CoreRuntimeOptions = {}) {
  const host = opts.host ?? process.env.MYAGENTS_HOST ?? '127.0.0.1'
  const port = opts.port ?? Number(process.env.MYAGENTS_PORT || 3210)
  const dbPath = opts.dbPath ?? myagentsDbPath()
  const isNonLoopback = !['127.0.0.1', 'localhost', '::1'].includes(host)
  const startedAt = Date.now()

  const database = new CoreDatabase(dbPath)
  const auth = new AuthService(database)
  const secrets = new DefaultSecretProvider()
  const redactor = new BasicRedactor()
  const approvalGate = new NoopApprovalGate()
  const isolator = new AgentEnvironmentIsolator()

  const daemon = new DaemonClient(opts.daemonEndpoint)
  await daemon.connect(opts.autoStartDaemon ?? true)

  const workspaces = new WorkspaceService(database)
  const git = new GitService()
  const terminals = new TerminalService(database, daemon, workspaces)
  const providers = new ProviderService(database, secrets)
  const envCheck = new EnvCheckService()
  const agents = new AgentService(database, workspaces)

  let httpServer: CoreHttpServer | null = null
  let inbox: InboxService | null = null

  const collab = new CollabEngine(database, agents, workspaces, isolator, daemon, {
    roomUpdated: (room) => httpServer?.broadcast('room.updated', room),
    roomDeleted: (roomId) => httpServer?.broadcast('room.deleted', { roomId }),
    messageCreated: (msg) => httpServer?.broadcast('room.messageCreated', msg),
    messagesRevealed: (ev) => httpServer?.broadcast('room.messagesRevealed', ev),
    streamDelta: (delta) => httpServer?.broadcast('room.streamDelta', delta),
    workNodeUpdated: (node) => httpServer?.broadcast('workNode.updated', node),
    rootNodeSettled: (node) => inbox?.onRootNodeSettled(node)
  })

  collab.registerDriver(new BuiltinDriver(providers, workspaces, git, daemon, approvalGate, redactor))
  collab.registerDriver(new ClaudeCodeDriver(daemon))
  collab.registerDriver(new CodexCliDriver(daemon))
  collab.registerDriver(new AcpCliDriver(daemon))

  const plugins = new PluginManager(database, secrets)
  inbox = new InboxService(database, collab, agents, plugins, (item) => {
    httpServer?.broadcast('inbox.updated', item)
  })

  // Startup reconcile BEFORE opening write endpoints
  const live = await daemon.call('list', {})
  terminals.reconcile(live.sessions)
  await collab.reconcile(live.sessions)

  const rpcRouter = new RpcRouter({
    auth,
    daemon,
    providers,
    envCheck,
    agents,
    workspaces,
    git,
    terminals,
    collab,
    inbox,
    plugins,
    isNonLoopback
  })

  const internalToken = randomBytes(24).toString('hex')

  httpServer = await createCoreHttpServer({
    auth,
    rpcRouter,
    workspaces,
    terminals,
    isNonLoopback,
    internalToken,
    onInternalMcpCall: (req) => collab.handleCollabToolCall(req),
    onGenericWebhook: (hookId, secret, req) => inbox!.ingestGenericWebhook(hookId, secret, req),
    onPluginWebhook: (pluginId, instanceId, req) => inbox!.ingestPluginWebhook(pluginId, instanceId, req),
    getHealth: () => ({
      ok: true,
      daemonConnected: daemon.isConnected,
      reconciling: collab.isReconciling,
      uptimeMs: Date.now() - startedAt,
      version: '0.1.0'
    })
  })

  await httpServer.listen(host, port)

  // Write local runtime endpoint metadata (0600) for restart-resilient MCP stdio bridge
  if (dbPath !== ':memory:' || opts.writeCoreEndpoint) {
    writePrivateFileSync(
      coreEndpointPath(),
      JSON.stringify({ host, port, pid: process.pid, internalToken, startedAt }, null, 2)
    )
  }

  console.log(`[core] listening on http://${host}:${port} (pid=${process.pid})`)
  if (isNonLoopback && auth.isDefaultPassword()) {
    console.warn('[core] WARNING: Listening on non-loopback address with default admin/admin password! Please change it in Settings.')
  }

  return {
    host,
    port,
    database,
    auth,
    daemon,
    workspaces,
    terminals,
    providers,
    agents,
    collab,
    async stop() {
      collab.abortInProcessRuns()
      await httpServer?.close()
      daemon.close()
      database.close()
    }
  }
}

// Direct CLI entrypoint
const isMain = process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')
if (isMain) {
  startCoreServer()
    .then((server) => {
      const shutdown = async () => {
        console.log('[core] shutting down (daemon processes remain alive)...')
        await server.stop()
        process.exit(0)
      }
      process.on('SIGINT', () => void shutdown())
      process.on('SIGTERM', () => void shutdown())
    })
    .catch((err) => {
      console.error('[core] fatal:', err)
      process.exit(1)
    })
}
