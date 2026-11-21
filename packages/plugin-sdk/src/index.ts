import type { CollabStrategy, FileRef } from '@myagents/protocol'
import type { z } from 'zod'

export interface InboundEnvelope {
  id: string
  source: string
  externalKey: string
  externalUrl?: string
  authorName: string
  title: string
  content: string
  attachments: FileRef[]
  rawMeta?: Record<string, unknown>
  replyTarget?: Record<string, unknown>
}

export interface PluginContext<TConfig = unknown> {
  instanceId: string
  config: TConfig
  resolveSecret(ref: string): Promise<string | null>
  storeAttachment?(input: { filename: string; mime?: string; buffer: Buffer }): Promise<FileRef>
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface SourcePlugin<TConfig = unknown> {
  readonly id: string
  readonly name: string
  readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
  pull?(ctx: PluginContext<TConfig>, cursor?: string): Promise<{ envelopes: InboundEnvelope[]; nextCursor?: string }>
  parseWebhook?(
    ctx: PluginContext<TConfig>,
    req: { headers: Record<string, string>; rawBody: Buffer }
  ): Promise<InboundEnvelope[]>
  reply?(
    ctx: PluginContext<TConfig>,
    target: Record<string, unknown>,
    payload: { text: string; attachments?: FileRef[] }
  ): Promise<void>
}

export type StrategyPlugin<TConfig = Record<string, unknown>, TState = Record<string, unknown>> = CollabStrategy<
  TConfig,
  TState
>
