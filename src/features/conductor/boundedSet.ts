/**
 * A Set that forgets its oldest entries instead of growing forever.
 *
 * Three of these live for the lifetime of the renderer and only ever grow:
 * every plan message the engine has looked at, every conductor turn that
 * answered directly, every session that has been seen running. Each entry is
 * a short string, so none of them is a leak that fails today — they are the
 * kind that fails after a week of the app being left open, which is exactly
 * the operating mode this product is for.
 *
 * The trade is deliberate and worth naming. These sets are "have I already
 * dealt with this?", so evicting an entry means a very old message could be
 * looked at a second time. That is survivable for all three uses — the plan
 * detector also consults the persisted tombstones, which outlive the process
 * — while unbounded growth is not. The cap is set high enough that reaching
 * it takes far more conductor turns than a session ever has.
 */
export class BoundedSet {
  private readonly entries = new Set<string>();

  constructor(private readonly limit: number) {}

  has(value: string): boolean {
    return this.entries.has(value);
  }

  /**
   * Adds one entry, evicting the oldest if that puts it over the limit.
   *
   * Insertion order is `Set`'s own iteration order, so the oldest entry is
   * whatever `keys().next()` yields — no second structure to keep in step.
   */
  add(value: string): void {
    // Re-adding must not renew an entry's age: these are "seen" marks, and a
    // mark that keeps refreshing itself would pin the oldest entries forever.
    if (this.entries.has(value)) return;
    this.entries.add(value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(value: string): boolean {
    return this.entries.delete(value);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
