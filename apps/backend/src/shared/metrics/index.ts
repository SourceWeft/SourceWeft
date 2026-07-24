import { logger } from "../logger";

/**
 * Minimal in-process metrics: counters (delta), gauges (current), and
 * observations (count/sum/max). Flushed as one structured `metrics.snapshot`
 * log line per interval through the existing pino pipeline — no new infra. This
 * is the seam a future `GET /internal/metrics` Prometheus exposition would use.
 */
type Labels = Record<string, string | number>;

function labelKey(name: string, labels?: Labels): string {
  if (!labels) {
    return name;
  }
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`);
  return parts.length > 0 ? `${name}{${parts.join(",")}}` : name;
}

class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly observations = new Map<
    string,
    { count: number; sum: number; max: number }
  >();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  inc(name: string, labels?: Labels, amount = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  gauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(labelKey(name, labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const key = labelKey(name, labels);
    const current = this.observations.get(key) ?? { count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += value;
    current.max = Math.max(current.max, value);
    this.observations.set(key, current);
  }

  snapshot() {
    const observations: Record<
      string,
      { count: number; sum: number; max: number; avg: number }
    > = {};
    for (const [key, value] of this.observations) {
      observations[key] = {
        ...value,
        avg: value.count > 0 ? value.sum / value.count : 0,
      };
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      observations,
    };
  }

  /** Log one snapshot line per interval, then reset deltas (gauges persist). */
  startPeriodicFlush(intervalMs = 60_000): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => {
      if (
        this.counters.size === 0 &&
        this.gauges.size === 0 &&
        this.observations.size === 0
      ) {
        return;
      }
      logger.info("metrics.snapshot", this.snapshot());
      this.counters.clear();
      this.observations.clear();
    }, intervalMs);
    // Don't keep the process alive for the flush timer.
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export const metrics = new Metrics();
