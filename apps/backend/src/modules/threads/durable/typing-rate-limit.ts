// Just below the client's leading-edge throttle so an honest client is never
// dropped, but a spammer is bounded to ~1 broadcast / interval / thread.
export const SERVER_MIN_INTERVAL_MS = 1500;
const PRUNE_INTERVAL_MS = 60_000;

/**
 * In-memory, per-replica throttle for typing pings. A typing POST lands on one
 * replica, so no cross-replica coordination is needed; under LB spray the worst
 * case is replicaCount broadcasts per interval, still bounded. Entries older
 * than the interval carry no signal (the next call would be allowed anyway), so
 * they are pruned lazily to keep the map small.
 */
class TypingRateLimiter {
  private readonly lastSentAt = new Map<string, number>();
  private lastPruneAt = 0;

  allow(userId: string, threadId: string): boolean {
    const now = Date.now();
    this.maybePrune(now);
    const key = `${userId}:${threadId}`;
    const previous = this.lastSentAt.get(key) ?? 0;
    if (now - previous < SERVER_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastSentAt.set(key, now);
    return true;
  }

  private maybePrune(now: number): void {
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneAt = now;
    for (const [key, ts] of this.lastSentAt) {
      if (now - ts >= SERVER_MIN_INTERVAL_MS) {
        this.lastSentAt.delete(key);
      }
    }
  }
}

export const typingRateLimiter = new TypingRateLimiter();
