import { z } from 'zod'

export const UnreferencedBlobItemSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number()
})
export type UnreferencedBlobItem = z.infer<typeof UnreferencedBlobItemSchema>

export const BlobStorageSummarySchema = z.object({
  totalFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  referencedFiles: z.number().int().nonnegative(),
  referencedBytes: z.number().int().nonnegative(),
  unreferencedFiles: z.number().int().nonnegative(),
  unreferencedBytes: z.number().int().nonnegative(),
  outboxPendingCount: z.number().int().nonnegative(),
  unreferencedItems: z.array(UnreferencedBlobItemSchema)
})
export type BlobStorageSummary = z.infer<typeof BlobStorageSummarySchema>

export const BlobPurgeResultSchema = z.object({
  deletedFileRecords: z.number().int().nonnegative(),
  deletedPhysicalBlobs: z.number().int().nonnegative(),
  reclaimedBytes: z.number().int().nonnegative(),
  errors: z.array(z.string())
})
export type BlobPurgeResult = z.infer<typeof BlobPurgeResultSchema>
