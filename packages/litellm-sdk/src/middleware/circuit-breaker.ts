export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;

  private readonly cooldownMs: number;

  private failureCount = 0;

  private openedAt: number | null = null;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.cooldownMs = options?.cooldownMs ?? 15_000;
  }

  canExecute(nowMs: number = Date.now()): boolean {
    if (this.openedAt === null) {
      return true;
    }

    if (nowMs - this.openedAt >= this.cooldownMs) {
      this.openedAt = null;
      this.failureCount = 0;
      return true;
    }

    return false;
  }

  recordSuccess() {
    this.failureCount = 0;
    this.openedAt = null;
  }

  recordFailure(nowMs: number = Date.now()) {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.openedAt = nowMs;
    }
  }

  get state(): "closed" | "open" {
    return this.openedAt === null ? "closed" : "open";
  }
}
