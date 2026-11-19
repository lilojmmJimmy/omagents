// Adapted from Antumi OutputBuffer (Apache License 2.0).
export class OutputBuffer {
  private chunks: string[] = []
  private size = 0
  private total = 0

  constructor(private readonly limit: number) {}

  get endOffset(): number {
    return this.total
  }

  append(data: string): number {
    const offset = this.total
    this.chunks.push(data)
    this.size += data.length
    this.total += data.length
    while (this.size > this.limit) {
      const first = this.chunks[0]!
      const excess = this.size - this.limit
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.slice(excess)
        this.size -= excess
      }
    }
    return offset
  }

  snapshot(): { buffer: string; bufferStart: number; endOffset: number } {
    const buffer = this.chunks.join('')
    this.chunks = buffer ? [buffer] : []
    return { buffer, bufferStart: this.total - buffer.length, endOffset: this.total }
  }
}
