/**
 * Backlog of terminal output that has not been written to xterm yet.
 *
 * A parked (detached) terminal is never drained while the backend keeps
 * streaming, so the backlog sits at its cap for as long as the chat stays in
 * the background. Keeping the chunks as they arrived and dropping them off the
 * front makes every incoming chunk cost O(chunk) instead of re-copying the
 * whole capped buffer per event.
 */
export class TerminalOutputBuffer {
  private chunks: string[] = [];
  private total = 0;

  constructor(private readonly maxChars: number) {}

  /** Characters currently buffered. */
  get length(): number {
    return this.total;
  }

  /** Chunks still held; exposed so tests can pin the amortised drop. */
  get chunkCount(): number {
    return this.chunks.length;
  }

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.total += data.length;
    while (this.total > this.maxChars && this.chunks.length > 0) {
      const oldest = this.chunks[0];
      const excess = this.total - this.maxChars;
      if (oldest.length <= excess) {
        this.chunks.shift();
        this.total -= oldest.length;
        continue;
      }
      // Only the chunk straddling the cap is ever re-sliced.
      this.chunks[0] = oldest.slice(excess);
      this.total -= excess;
    }
  }

  /** Removes and returns at most `limit` characters from the front. */
  take(limit: number): string {
    if (limit <= 0) return "";
    const parts: string[] = [];
    let taken = 0;
    while (taken < limit && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const remaining = limit - taken;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        taken += chunk.length;
        this.chunks.shift();
        continue;
      }
      parts.push(chunk.slice(0, remaining));
      this.chunks[0] = chunk.slice(remaining);
      taken += remaining;
    }
    this.total -= taken;
    return parts.join("");
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}
