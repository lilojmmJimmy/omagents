import type { FileRef } from '@myagents/protocol'
import type { InboundEnvelope, PluginContext, SourcePlugin } from '@myagents/plugin-sdk'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import { z } from 'zod'
import { Errors } from '../../errors'

const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024

export const EmailPluginConfigSchema = z.object({
  imapHost: z.string().trim().min(1),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993),
  imapSecure: z.boolean().default(true),
  imapUser: z.string().trim().min(1),
  imapPass: z.string().default(''),
  mailbox: z.string().trim().min(1).default('INBOX'),
  maxFetchPerSync: z.coerce.number().int().min(1).max(100).default(20),
  markSeen: z.boolean().default(false),
  smtpHost: z.string().trim().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
  smtpSecure: z.boolean().default(true),
  smtpUser: z.string().trim().optional(),
  smtpPass: z.string().optional(),
  fromAddress: z.string().trim().optional(),
  autoReplyOnResolve: z.boolean().default(true)
}).passthrough()

export type EmailPluginConfig = z.infer<typeof EmailPluginConfigSchema>

export interface ImapMailboxLockLike {
  release(): void
}

export interface ImapFetchedMessageLike {
  uid: number
  source?: Buffer
}

export interface ImapClientLike {
  mailbox: { exists?: number; uidValidity?: bigint | number; uidNext?: number } | false
  connect(): Promise<void>
  getMailboxLock(mailbox: string): Promise<ImapMailboxLockLike>
  fetchAll(
    range: string,
    query: { uid: boolean; source: boolean },
    options?: { uid?: boolean }
  ): Promise<ImapFetchedMessageLike[]>
  messageFlagsAdd?(range: string | number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>
  logout(): Promise<void>
  close(): void
}

export interface SmtpTransportLike {
  sendMail(mail: {
    from: string
    to: string
    subject: string
    text: string
    inReplyTo?: string
    references?: string | string[]
  }): Promise<unknown>
  close?(): void
}

export interface EmailTransportDeps {
  createImapClient?(config: {
    host: string
    port: number
    secure: boolean
    user: string
    pass: string
  }): ImapClientLike
  createSmtpTransport?(config: {
    host: string
    port: number
    secure: boolean
    user?: string
    pass?: string
  }): SmtpTransportLike
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseCursor(cursor?: string): { uidValidity: string | null; lastUid: number } {
  if (!cursor) return { uidValidity: null, lastUid: 0 }
  const idx = cursor.indexOf(':')
  if (idx <= 0) return { uidValidity: null, lastUid: 0 }
  const uidValidity = cursor.slice(0, idx)
  const lastUid = Number(cursor.slice(idx + 1))
  return {
    uidValidity,
    lastUid: Number.isFinite(lastUid) && lastUid >= 0 ? Math.floor(lastUid) : 0
  }
}

export function createEmailPlugin(deps: EmailTransportDeps = {}): SourcePlugin<EmailPluginConfig> {
  const createImap =
    deps.createImapClient ??
    ((cfg) =>
      new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
        logger: false,
        // Identify client cleanly so stricter providers (e.g. 163/QQ) accept SELECT
        clientInfo: { name: 'MyAgents', version: '0.2.0' }
      }))

  const createSmtp =
    deps.createSmtpTransport ??
    ((cfg) =>
      nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined
      }))

  return {
    id: 'email-imap-smtp',
    name: 'Email (IMAP / SMTP)',
    configSchema: EmailPluginConfigSchema,

    async pull(ctx: PluginContext<EmailPluginConfig>, cursor?: string) {
      const cfg = EmailPluginConfigSchema.parse(ctx.config)
      const imapPass = cfg.imapPass ? ((await ctx.resolveSecret(cfg.imapPass)) ?? '') : ''
      if (!imapPass) {
        throw Errors.invalidParams('IMAP password or env: secret is required')
      }

      const client = createImap({
        host: cfg.imapHost,
        port: cfg.imapPort,
        secure: cfg.imapSecure,
        user: cfg.imapUser,
        pass: imapPass
      })

      await client.connect()
      try {
        const lock = await client.getMailboxLock(cfg.mailbox)
        try {
          const mb = client.mailbox || {}
          const uidValidity = mb.uidValidity !== undefined ? String(mb.uidValidity) : '0'
          const exists = typeof mb.exists === 'number' ? mb.exists : 0
          const uidNext = typeof mb.uidNext === 'number' ? mb.uidNext : undefined

          if (exists === 0) {
            return { envelopes: [], nextCursor: `${uidValidity}:0` }
          }

          const prev = parseCursor(cursor)
          const isSameMailbox = prev.uidValidity === uidValidity && prev.lastUid > 0
          if (isSameMailbox && uidNext !== undefined && uidNext <= prev.lastUid + 1) {
            return { envelopes: [], nextCursor: `${uidValidity}:${prev.lastUid}` }
          }

          let rawMessages: ImapFetchedMessageLike[]
          if (isSameMailbox) {
            rawMessages = await client.fetchAll(`${prev.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })
            rawMessages = rawMessages.filter((m) => m.uid > prev.lastUid)
          } else {
            const startSeq = Math.max(1, exists - cfg.maxFetchPerSync + 1)
            rawMessages = await client.fetchAll(`${startSeq}:${exists}`, { uid: true, source: true }, { uid: false })
          }

          rawMessages.sort((a, b) => a.uid - b.uid)
          const batch = rawMessages.slice(0, cfg.maxFetchPerSync)

          const envelopes: InboundEnvelope[] = []
          const fetchedUids: number[] = []
          let highestUid = isSameMailbox ? prev.lastUid : 0

          for (const msg of batch) {
            if (!msg.source) continue
            highestUid = Math.max(highestUid, msg.uid)
            fetchedUids.push(msg.uid)

            const parsed = await simpleParser(msg.source)
            const subject = (parsed.subject || '(No Subject)').trim().slice(0, 200)
            const fromAddr = parsed.from?.value?.[0]?.address || ''
            const replyToAddr = parsed.replyTo?.value?.[0]?.address || fromAddr
            const authorName = parsed.from?.value?.[0]?.name || fromAddr || parsed.from?.text || 'email'

            let content = (parsed.text || '').trim()
            if (!content && typeof parsed.html === 'string') {
              content = stripHtml(parsed.html)
            }
            if (!content) content = subject

            const attachments: FileRef[] = []
            if (ctx.storeAttachment && Array.isArray(parsed.attachments)) {
              for (const att of parsed.attachments) {
                if (!Buffer.isBuffer(att.content) || att.content.byteLength === 0) continue
                if (att.content.byteLength > MAX_EMAIL_ATTACHMENT_BYTES) continue
                const ref = await ctx.storeAttachment({
                  filename: att.filename || 'email-attachment.bin',
                  mime: att.contentType || 'application/octet-stream',
                  buffer: att.content
                })
                attachments.push(ref)
              }
            }

            const existingRefs = Array.isArray(parsed.references)
              ? parsed.references
              : parsed.references
                ? [parsed.references]
                : []
            const references = [...existingRefs, ...(parsed.messageId ? [parsed.messageId] : [])]
            const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`

            envelopes.push({
              id: msg.uid.toString(),
              source: 'email',
              externalKey: parsed.messageId ? `${cfg.mailbox}:${parsed.messageId}` : `imap:${uidValidity}:${msg.uid}`,
              authorName,
              title: subject,
              content,
              attachments,
              rawMeta: {
                mailbox: cfg.mailbox,
                uid: msg.uid,
                uidValidity,
                fromAddress: fromAddr,
                messageId: parsed.messageId ?? null
              },
              replyTarget: replyToAddr
                ? {
                    to: replyToAddr,
                    subject: reSubject,
                    inReplyTo: parsed.messageId ?? undefined,
                    references
                  }
                : undefined
            })
          }

          if (cfg.markSeen && fetchedUids.length > 0 && client.messageFlagsAdd) {
            await client.messageFlagsAdd(fetchedUids, ['\\Seen'], { uid: true })
          }

          return {
            envelopes,
            nextCursor: `${uidValidity}:${highestUid}`
          }
        } finally {
          lock.release()
        }
      } finally {
        try {
          await client.logout()
        } catch {
          client.close()
        }
      }
    },

    async reply(ctx: PluginContext<EmailPluginConfig>, target, payload) {
      const cfg = EmailPluginConfigSchema.parse(ctx.config)
      if (!cfg.smtpHost) {
        throw Errors.invalidParams('SMTP host is not configured for email replies')
      }
      const to = typeof target.to === 'string' ? target.to.trim() : ''
      if (!to) {
        throw Errors.invalidParams('Email replyTarget missing recipient "to" address')
      }

      const smtpUser = cfg.smtpUser || cfg.imapUser
      const passRef = cfg.smtpPass || cfg.imapPass
      const smtpPass = passRef ? ((await ctx.resolveSecret(passRef)) ?? '') : ''
      const from = cfg.fromAddress || smtpUser

      const transport = createSmtp({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure,
        user: smtpUser,
        pass: smtpPass
      })
      try {
        await transport.sendMail({
          from,
          to,
          subject: typeof target.subject === 'string' && target.subject.trim() ? target.subject.trim() : 'Re: Support Ticket',
          text: payload.text,
          inReplyTo: typeof target.inReplyTo === 'string' ? target.inReplyTo : undefined,
          references: Array.isArray(target.references)
            ? target.references.map(String)
            : typeof target.references === 'string'
              ? target.references
              : undefined
        })
      } finally {
        transport.close?.()
      }
    }
  }
}

export const emailPlugin = createEmailPlugin()
