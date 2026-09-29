/**
 * The `supports` value a Provider definition declares when it enforces a
 * strict `response_format: { type: "json_schema", json_schema: { strict: true } }`.
 * Declared per Provider, not per model: the exceptions (a model whose routed
 * endpoints cannot honour it) are found at request time and remembered in
 * {@link StrictJsonSchemaSupportCache}.
 */
export const STRICT_JSON_SCHEMA_SUPPORT = "json_schema_strict";

/** How long a (Provider, model) that rejected strict output is not asked again. */
export const STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS = 60 * 60 * 1000;

const DEFAULT_MAX_ENTRIES = 1_000;

type StrictJsonSchemaSupportKeyInput = {
  provider: string;
  providerModel: string;
};

function supportKey(target: StrictJsonSchemaSupportKeyInput): string {
  return `${target.provider}::${target.providerModel}`;
}

/**
 * In-process memory of (Provider, model) pairs whose strict JSON-schema request
 * was rejected (see `classifyStrictJsonSchemaRejection`), so the next calls go
 * straight to the non-strict path instead of paying a failed round-trip first.
 *
 * Advisory and bounded, like the target health registry: an entry expires after
 * {@link STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS} so a model whose endpoints gain
 * support is tried again, and the oldest entry is evicted once `maxEntries` is
 * reached. Nothing is persisted; a restart simply re-learns.
 */
export class StrictJsonSchemaSupportCache {
  private readonly unsupportedUntil = new Map<string, number>();

  constructor(
    private readonly options?: {
      ttlMs?: number;
      maxEntries?: number;
      /** Injectable clock for tests. */
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }

  get size(): number {
    return this.unsupportedUntil.size;
  }

  markUnsupported(target: StrictJsonSchemaSupportKeyInput): void {
    const key = supportKey(target);
    const now = this.now();
    // Re-inserting moves the key to the end of the eviction order.
    this.unsupportedUntil.delete(key);
    const maxEntries = this.options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (this.unsupportedUntil.size >= maxEntries) {
      for (const [existing, until] of this.unsupportedUntil) {
        if (until <= now) this.unsupportedUntil.delete(existing);
      }
    }
    while (this.unsupportedUntil.size >= maxEntries) {
      const oldest = this.unsupportedUntil.keys().next().value;
      if (oldest === undefined) break;
      this.unsupportedUntil.delete(oldest);
    }
    this.unsupportedUntil.set(
      key,
      now + (this.options?.ttlMs ?? STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS),
    );
  }

  isUnsupported(target: StrictJsonSchemaSupportKeyInput): boolean {
    const key = supportKey(target);
    const until = this.unsupportedUntil.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.unsupportedUntil.delete(key);
      return false;
    }
    return true;
  }
}

/** The process-wide cache; a gateway config may pass its own instead. */
export const defaultStrictJsonSchemaSupport =
  new StrictJsonSchemaSupportCache();
