import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { SourcePlugin } from '@myagents/plugin-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CollabEngine } from '../collab/collab-engine'
import type { DaemonClient } from '../daemon-client'
import { AgentService } from '../runtime/agent-service'
import type { AgentDriver, TurnOutput } from '../runtime/driver'
import { AgentEnvironmentIsolator } from '../runtime/environment-isolator'
import { BasicRedactor, DefaultSecretProvider } from '../security/hooks'
import { BlobService } from '../storage/blob-service'
import { CoreDatabase } from '../storage/database'
import { WorkspaceService } from '../workspace/workspace-service'
import { InboxService } from './inbox-service'
import { PluginManager } from './plugin-manager'
import { createEmailPlugin, type ImapClientLike, type SmtpTransportLike } from './plugins/email-plugin'
import { createGitHubPlugin } from './plugins/github-plugin'

let tmpDir: string
let projectDir: string
const prevHome = process.env.MYAGENTS_HOME

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'myagents-channels-'))
  process.env.MYAGENTS_HOME = path.join(tmpDir, 'home')
  mkdirSync(process.env.MYAGENTS_HOME, { recursive: true })
  projectDir = path.join(tmpDir, 'project')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path.join(projectDir, 'index.ts'), 'export const ok = true\n', 'utf8')
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.MYAGENTS_HOME
  else process.env.MYAGENTS_HOME = prevHome
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

function buildMultipartRfc822(opts: {
  from: string
  replyTo?: string
  subject: string
  messageId: string
  textBody: string
  attachmentName: string
  attachmentContent: string
}): Buffer {
  const boundary = '----MyAgentsTestBoundary123'
  const attB64 = Buffer.from(opts.attachmentContent, 'utf8').toString('base64')
  const raw = [
    `From: ${opts.from}`,
    ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
    `To: support@myagents.local`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    opts.textBody,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; name="${opts.attachmentName}"`,
    `Content-Disposition: attachment; filename="${opts.attachmentName}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    attB64,
    `--${boundary}--`,
    ``
  ].join('\r\n')
  return Buffer.from(raw, 'utf8')
}

function createHarness() {
  const db = new CoreDatabase(':memory:')
  const blobs = new BlobService(db)
  const redactor = new BasicRedactor()
  const workspaces = new WorkspaceService(db)
  const agents = new AgentService(db, workspaces)
  const isolator = new AgentEnvironmentIsolator()
  const inboxRef: { current?: InboxService } = {}
  const collab = new CollabEngine(
    db,
    agents,
    workspaces,
    isolator,
    {} as DaemonClient,
    {
      roomUpdated: () => {},
      roomDeleted: () => {},
      messageCreated: () => {},
      streamDelta: () => {},
      workNodeUpdated: () => {},
      rootNodeSettled: (node) => inboxRef.current?.onRootNodeSettled(node)
    },
    { blobs }
  )
  const stubDriver: AgentDriver = {
    kind: 'codex',
    capabilities: {
      supportsNativeResume: false,
      supportsSteerWhileRunning: false,
      supportsReadOnlyEnforcement: true,
      supportsDynamicMcp: true,
      supportsSubagentBlock: true
    },
    async runTurn(): Promise<TurnOutput> {
      return { finalText: 'Checked diagnostics and fixed config.' }
    }
  }
  collab.registerDriver(stubDriver)

  const plugins = new PluginManager(db, new DefaultSecretProvider(), blobs, redactor)
  const inbox = new InboxService(db, collab, agents, plugins, undefined, blobs)
  inboxRef.current = inbox
  return { db, blobs, redactor, workspaces, agents, collab, plugins, inbox }
}

describe('T-103 Inbox Routing Workspace + Outbound Replies & T-301 Email / GitHub Plugins', () => {
  it('binds rule target workspace, dispatches outbound reply on resolve, and records reply failures gracefully (T-103)', async () => {
    const h = createHarness()
    await h.collab.reconcile([])

    const proj = await h.workspaces.registerProject({ name: 'TargetProj', rootPath: projectDir })
    const bot = h.agents.create({
      name: 'TicketBot',
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

    const sentReplies: Array<{ target: Record<string, unknown>; text: string }> = []
    let failReply = false
    const mockReplyPlugin: SourcePlugin<{ apiKey?: string }> = {
      id: 'mock-ticket',
      name: 'Mock Ticket',
      configSchema: z.object({ apiKey: z.string().optional() }),
      async reply(_ctx, target, payload) {
        if (failReply) throw new Error('Upstream 503')
        sentReplies.push({ target, text: payload.text })
      }
    }
    h.plugins.register(mockReplyPlugin)
    const inst = h.plugins.configureInstance({
      pluginId: 'mock-ticket',
      name: 'MockDesk',
      config: { apiKey: 'secret-desk-999' },
      enabled: true
    })

    // Rule specifies explicit project workspace
    const rule = h.inbox.saveRule({
      name: 'RouteToTargetProj',
      priority: 1,
      sourceFilter: 'mock-ticket',
      matchType: 'always',
      matchExpr: '',
      allowWrite: false,
      enabled: true,
      action: {
        mode: 'create_room',
        strategyId: 'single',
        agentIds: [bot.id],
        workspaceId: proj.id
      }
    })

    const item1 = await h.inbox.ingestEnvelope(
      {
        id: 'tk-1',
        source: 'mock-ticket',
        externalKey: 'tk-1',
        authorName: 'alice',
        title: 'API 502 error',
        content: 'Please inspect',
        attachments: [],
        replyTarget: { threadId: 'th-100' }
      },
      inst.id
    )
    expect(item1.assignedRoomId).toBeTruthy()
    const createdRoom = h.collab.getRoom(item1.assignedRoomId!)
    expect(createdRoom.primaryWorkspaceId).toBe(proj.id)

    // Wait deterministically for background stubDriver turn -> onRootNodeSettled -> auto-reply
    let resolved1 = h.inbox.getItem(item1.id)
    for (let i = 0; i < 60; i++) {
      resolved1 = h.inbox.getItem(item1.id)
      if (
        resolved1.status === 'resolved' &&
        (resolved1.rawMeta._reply as { status?: string } | undefined)?.status === 'sent'
      ) {
        break
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(resolved1.status).toBe('resolved')
    expect(sentReplies).toEqual([{ target: { threadId: 'th-100' }, text: 'Checked diagnostics and fixed config.' }])
    expect((resolved1.rawMeta._reply as { status: string }).status).toBe('sent')

    // Disable auto-routing rule for item2 so manual setStatus / reply failure is tested deterministically
    h.inbox.saveRule({ ...rule, enabled: false })
    failReply = true
    const item2 = await h.inbox.ingestEnvelope(
      {
        id: 'tk-2',
        source: 'mock-ticket',
        externalKey: 'tk-2',
        authorName: 'bob',
        title: 'Retry test',
        content: 'Failing reply',
        attachments: [],
        replyTarget: { threadId: 'th-200' }
      },
      inst.id
    )
    const resolved2 = await h.inbox.setStatus(item2.id, 'resolved')
    expect(resolved2.status).toBe('resolved')
    expect((resolved2.rawMeta._reply as { status: string; error: string }).status).toBe('failed')
    await expect(h.inbox.replyToItem(item2.id, 'Retry now')).rejects.toThrow(/Upstream 503/)

    h.collab.abortInProcessRuns()
    h.db.close()
  })

  it('polls IMAP emails with MIME attachments into BlobService, masks & preserves secrets, and sends threaded SMTP replies (T-301 Email)', async () => {
    const h = createHarness()

    const rfc822Msg = buildMultipartRfc822({
      from: 'Customer <alice@example.com>',
      replyTo: 'reply-alice@example.com',
      subject: 'Invoice Sync Error',
      messageId: '<msg-42@example.com>',
      textBody: 'Attached is the error trace.',
      attachmentName: 'trace.txt',
      attachmentContent: 'NullPointerException at Sync.ts:19'
    })

    const sentEmails: Array<{ from: string; to: string; subject: string; text: string; inReplyTo?: string }> = []
    const uidNextVal = 11

    const emailPlugin = createEmailPlugin({
      createImapClient: (): ImapClientLike => ({
        mailbox: { exists: 1, uidValidity: 99, uidNext: uidNextVal },
        async connect() {},
        async getMailboxLock() {
          return { release() {} }
        },
        async fetchAll() {
          return uidNextVal === 11 ? [{ uid: 10, source: rfc822Msg }] : []
        },
        async logout() {},
        close() {}
      }),
      createSmtpTransport: (): SmtpTransportLike => ({
        async sendMail(mail) {
          sentEmails.push(mail)
        },
        close() {}
      })
    })
    h.plugins.register(emailPlugin)

    const inst = h.plugins.configureInstance({
      pluginId: 'email-imap-smtp',
      name: 'SupportMailbox',
      config: {
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'support@myagents.local',
        imapPass: 'super-imap-pass',
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true
      },
      enabled: true
    })

    // Returned config must mask secrets
    expect(inst.config.imapPass).toBe('••••••••')
    expect(h.plugins.listInstances()[0]?.config.imapPass).toBe('••••••••')

    // Updating non-secret field while keeping masked placeholder must preserve raw password
    h.plugins.configureInstance({
      id: inst.id,
      pluginId: 'email-imap-smtp',
      name: 'SupportMailbox',
      config: {
        ...inst.config,
        mailbox: 'Support'
      },
      enabled: true
    })

    const synced = await h.inbox.syncPluginInstance(inst.id)
    expect(synced).toHaveLength(1)
    const item = synced[0]!
    expect(item.source).toBe('email')
    expect(item.title).toBe('Invoice Sync Error')
    expect(item.content).toContain('Attached is the error trace.')
    expect(item.attachments).toHaveLength(1)
    expect(item.attachments[0]!.filename).toBe('trace.txt')
    expect(h.blobs.readTextPreview(item.attachments[0]!.fileId)).toContain('NullPointerException')

    // Cursor updated cleanly and incremental sync finds no new messages
    const rawInst = h.plugins.listInstances().find((i) => i.id === inst.id)!
    expect(rawInst.cursor).toBe('99:10')
    expect(await h.inbox.syncPluginInstance(inst.id)).toEqual([])

    // Outbound SMTP reply preserves thread headers & Re: subject
    const replied = await h.inbox.replyToItem(item.id, 'Resolved on our end.')
    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0]).toMatchObject({
      from: 'support@myagents.local',
      to: 'reply-alice@example.com',
      subject: 'Re: Invoice Sync Error',
      text: 'Resolved on our end.',
      inReplyTo: '<msg-42@example.com>'
    })
    expect((replied.rawMeta._reply as { status: string }).status).toBe('sent')

    // Delete item moves attachment ref to outbox without deleting blob automatically
    h.inbox.deleteItem(item.id)
    expect(h.blobs.getStorageSummary().outboxPendingCount).toBe(1)

    h.db.close()
  })

  it('polls GitHub REST issues with PAT, filters PRs, masks PAT, and posts comment replies (T-301 GitHub)', async () => {
    const postedComments: Array<{ url: string; body: string; auth?: string }> = []
    let seenQuery = ''
    let seenAuth = ''

    const ghApi = http.createServer((req, res) => {
      seenAuth = req.headers.authorization || ''
      if (req.url?.startsWith('/repos/acme/app/issues') && req.method === 'GET') {
        seenQuery = req.url
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify([
            {
              id: 700,
              number: 7,
              title: 'Memory leak on reconnect',
              body: 'Observed after 100 WS reconnects',
              html_url: 'https://github.com/acme/app/issues/7',
              comments_url: `http://127.0.0.1:${ghPort}/repos/acme/app/issues/7/comments`,
              updated_at: '2026-11-20T05:00:00.000Z',
              user: { login: 'octocat' },
              labels: [{ name: 'bug' }]
            },
            {
              id: 701,
              number: 8,
              title: 'PR should be excluded',
              body: 'PR body',
              html_url: 'https://github.com/acme/app/pull/8',
              updated_at: '2026-11-20T05:01:00.000Z',
              user: { login: 'dev' },
              pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/8' }
            }
          ])
        )
        return
      }
      if (req.url === '/repos/acme/app/issues/7/comments' && req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const parsed = JSON.parse(raw) as { body: string }
          postedComments.push({ url: req.url!, body: parsed.body, auth: req.headers.authorization })
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 999 }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((r) => ghApi.listen(0, '127.0.0.1', () => r()))
    const ghPort = (ghApi.address() as { port: number }).port

    const h = createHarness()
    try {
      h.plugins.register(createGitHubPlugin())
      const inst = h.plugins.configureInstance({
        pluginId: 'github-webhook',
        name: 'AcmeApp',
        config: {
          repository: 'acme/app',
          token: 'ghp_super_secret_token_123',
          apiBaseUrl: `http://127.0.0.1:${ghPort}`,
          labels: 'bug',
          includePullRequests: false
        },
        enabled: true
      })

      expect(inst.config.token).toBe('••••••••')

      const synced = await h.inbox.syncPluginInstance(inst.id)
      expect(seenAuth).toBe('Bearer ghp_super_secret_token_123')
      expect(seenQuery).toContain('labels=bug')
      expect(synced).toHaveLength(1)
      expect(synced[0]!.externalKey).toBe('gh:acme/app#7')
      expect(h.redactor.scrub('Leaked ghp_super_secret_token_123!')).toBe('Leaked •••!')

      const replied = await h.inbox.replyToItem(synced[0]!.id, 'Fixed in main.')
      expect(postedComments).toEqual([
        {
          url: '/repos/acme/app/issues/7/comments',
          body: 'Fixed in main.',
          auth: 'Bearer ghp_super_secret_token_123'
        }
      ])
      expect((replied.rawMeta._reply as { status: string }).status).toBe('sent')
    } finally {
      ghApi.close()
      h.db.close()
    }
  })
})
