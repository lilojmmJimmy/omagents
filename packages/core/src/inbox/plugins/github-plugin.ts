import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { InboundEnvelope, PluginContext, SourcePlugin } from '@myagents/plugin-sdk'
import { z } from 'zod'
import { Errors } from '../../errors'

export const GitHubPluginConfigSchema = z
  .object({
    webhookSecret: z.string().optional(),
    repository: z.string().trim().optional(),
    token: z.string().optional(),
    apiBaseUrl: z.string().trim().url().default('https://api.github.com'),
    labels: z.string().trim().optional(),
    includePullRequests: z.boolean().default(true),
    maxFetchPerSync: z.coerce.number().int().min(1).max(100).default(20),
    autoReplyOnResolve: z.boolean().default(true)
  })
  .passthrough()

export type GitHubPluginConfig = z.infer<typeof GitHubPluginConfigSchema>

function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex.toLowerCase(), 'utf8')
  const b = Buffer.from(bHex.toLowerCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface GitHubIssueApiItem {
  id: number
  number: number
  title: string
  body?: string | null
  html_url?: string
  url?: string
  comments_url?: string
  updated_at?: string
  user?: { login?: string }
  labels?: Array<{ name?: string } | string>
  pull_request?: unknown
}

export function createGitHubPlugin(fetchImpl: typeof fetch = fetch): SourcePlugin<GitHubPluginConfig> {
  return {
    id: 'github-webhook',
    name: 'GitHub (Webhook / Pull / Reply)',
    configSchema: GitHubPluginConfigSchema,

    async parseWebhook(ctx, req): Promise<InboundEnvelope[]> {
      const secret = typeof ctx.config?.webhookSecret === 'string' ? ctx.config.webhookSecret.trim() : ''
      if (secret) {
        const sigHeader = req.headers['x-hub-signature-256'] || ''
        const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex')
        if (!sigHeader || !timingSafeHexEqual(sigHeader, expected)) {
          throw Errors.unauthorized('Invalid GitHub X-Hub-Signature-256')
        }
      }

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(req.rawBody.toString('utf8')) as Record<string, unknown>
      } catch {
        throw Errors.invalidParams('Invalid GitHub webhook JSON body')
      }

      const event = String(req.headers['x-github-event'] || payload.event || 'issue')
      const action = typeof payload.action === 'string' ? payload.action : 'opened'
      const repo =
        ((payload.repository as Record<string, unknown> | undefined)?.full_name as string | undefined) || 'unknown/repo'
      const sender = ((payload.sender as Record<string, unknown> | undefined)?.login as string | undefined) || 'github'
      const issue = (payload.issue ?? payload.pull_request) as Record<string, unknown> | undefined
      const comment = payload.comment as Record<string, unknown> | undefined
      const deliveryId = String(
        req.headers['x-github-delivery'] || `${event}:${repo}:${issue?.number ?? Date.now()}:${action}`
      )

      const title = comment
        ? `[GitHub ${repo}#${issue?.number ?? '?'}] New comment by @${sender}`
        : `[GitHub ${repo}#${issue?.number ?? '?'}] ${String(issue?.title || `${event} (${action})`)}`
      const content = comment
        ? String(comment.body || '')
        : String(issue?.body || payload.head_commit?.['message' as never] || JSON.stringify(payload).slice(0, 2000))
      const externalUrl =
        typeof comment?.html_url === 'string'
          ? comment.html_url
          : typeof issue?.html_url === 'string'
            ? issue.html_url
            : undefined

      const labels = Array.isArray(issue?.labels)
        ? issue!.labels.map((l) =>
            typeof l === 'object' && l && 'name' in l ? String((l as { name: unknown }).name) : String(l)
          )
        : []

      const issueNumber = typeof issue?.number === 'number' ? issue.number : undefined
      const commentsUrl =
        typeof issue?.comments_url === 'string'
          ? issue.comments_url
          : typeof issue?.url === 'string'
            ? `${issue.url}/comments`
            : undefined

      return [
        {
          id: randomUUID(),
          source: 'github',
          externalKey: deliveryId,
          externalUrl,
          authorName: sender,
          title,
          content: content || title,
          attachments: [],
          rawMeta: { event, action, repository: repo, labels, issueNumber },
          replyTarget:
            commentsUrl || issue?.url || (repo !== 'unknown/repo' && issueNumber !== undefined)
              ? {
                  ...(issue?.url ? { issueUrl: String(issue.url) } : {}),
                  ...(commentsUrl ? { commentsUrl } : {}),
                  repository: repo,
                  issueNumber
                }
              : undefined
        }
      ]
    },

    async pull(ctx: PluginContext<GitHubPluginConfig>, cursor?: string) {
      const cfg = GitHubPluginConfigSchema.parse(ctx.config)
      if (!cfg.repository || !/^[^/\s]+\/[^/\s]+$/.test(cfg.repository)) {
        throw Errors.invalidParams('GitHub repository must be formatted as "owner/repo" for pull sync')
      }

      const apiBase = cfg.apiBaseUrl.replace(/\/+$/, '')
      const url = new URL(`${apiBase}/repos/${cfg.repository}/issues`)
      url.searchParams.set('state', 'open')
      url.searchParams.set('sort', 'updated')
      url.searchParams.set('direction', 'asc')
      url.searchParams.set('per_page', String(cfg.maxFetchPerSync))
      if (cursor) url.searchParams.set('since', cursor)
      if (cfg.labels) url.searchParams.set('labels', cfg.labels)

      const token = cfg.token ? ((await ctx.resolveSecret(cfg.token)) ?? '') : ''
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MyAgents/0.2.0',
        'X-GitHub-Api-Version': '2022-11-28'
      }
      if (token) headers.Authorization = `Bearer ${token}`

      const res = await fetchImpl(url.toString(), { headers })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`GitHub pull failed (${res.status}): ${body.slice(0, 300)}`)
      }

      const rawItems = (await res.json()) as GitHubIssueApiItem[]
      const envelopes: InboundEnvelope[] = []
      let maxUpdatedMs = cursor ? Date.parse(cursor) : 0

      for (const issue of rawItems) {
        if (!cfg.includePullRequests && issue.pull_request) continue
        if (issue.updated_at) {
          const ms = Date.parse(issue.updated_at)
          if (Number.isFinite(ms) && ms > maxUpdatedMs) maxUpdatedMs = ms
        }
        const labels = Array.isArray(issue.labels)
          ? issue.labels.map((l) => (typeof l === 'string' ? l : String(l.name ?? ''))).filter(Boolean)
          : []
        const isPr = Boolean(issue.pull_request)
        envelopes.push({
          id: String(issue.id || issue.number),
          source: 'github',
          externalKey: `gh:${cfg.repository}#${issue.number}`,
          externalUrl: issue.html_url,
          authorName: issue.user?.login || 'github',
          title: `[GitHub ${cfg.repository}#${issue.number}] ${issue.title}`,
          content: issue.body || issue.title,
          attachments: [],
          rawMeta: {
            event: isPr ? 'pull_request' : 'issues',
            repository: cfg.repository,
            issueNumber: issue.number,
            labels
          },
          replyTarget: {
            commentsUrl: issue.comments_url || `${apiBase}/repos/${cfg.repository}/issues/${issue.number}/comments`,
            ...(issue.url ? { issueUrl: issue.url } : {}),
            repository: cfg.repository,
            issueNumber: issue.number
          }
        })
      }

      const nextCursor = maxUpdatedMs > 0 ? new Date(maxUpdatedMs + 1000).toISOString() : cursor
      return { envelopes, nextCursor }
    },

    async reply(ctx: PluginContext<GitHubPluginConfig>, target, payload) {
      const cfg = GitHubPluginConfigSchema.parse(ctx.config)
      const token = cfg.token ? ((await ctx.resolveSecret(cfg.token)) ?? '') : ''
      if (!token) {
        throw Errors.invalidParams('GitHub PAT token is required to post outbound comments')
      }

      const apiBase = cfg.apiBaseUrl.replace(/\/+$/, '')
      let endpoint =
        typeof target.commentsUrl === 'string' && /^https?:\/\//i.test(target.commentsUrl) ? target.commentsUrl : ''
      if (!endpoint && typeof target.issueUrl === 'string' && /^https?:\/\//i.test(target.issueUrl)) {
        endpoint = `${target.issueUrl.replace(/\/+$/, '')}/comments`
      }
      if (!endpoint && typeof target.repository === 'string' && typeof target.issueNumber === 'number') {
        endpoint = `${apiBase}/repos/${target.repository}/issues/${target.issueNumber}/comments`
      }
      if (!endpoint) {
        throw Errors.invalidParams('GitHub replyTarget missing commentsUrl / repository + issueNumber')
      }

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'MyAgents/0.2.0',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ body: payload.text })
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`GitHub comment reply failed (${res.status}): ${body.slice(0, 300)}`)
      }
    }
  }
}

export const githubPlugin = createGitHubPlugin()
