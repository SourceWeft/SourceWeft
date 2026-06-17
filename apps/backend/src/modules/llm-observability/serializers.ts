const MAX_SERIALIZE_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function serializeInternal(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (depth >= MAX_SERIALIZE_DEPTH) {
    return "[MaxDepth]";
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => serializeInternal(item, seen, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, serializeInternal(item, seen, depth + 1)] as const)
        .filter((entry): entry is [string, unknown] => entry[1] !== undefined),
    );
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function toJsonSafe(value: unknown): unknown {
  return serializeInternal(value, new WeakSet<object>(), 0);
}

export function toJsonRecord(value: unknown): Record<string, unknown> | null {
  const safe = toJsonSafe(value);
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? (safe as Record<string, unknown>)
    : null;
}

export function serializeError(error: unknown): {
  code?: string;
  message: string;
  name?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    const maybeCode = (error as { code?: unknown }).code;
    return {
      code: typeof maybeCode === "string" ? maybeCode : undefined,
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message:
        typeof record.message === "string"
          ? record.message
          : JSON.stringify(toJsonSafe(record)),
    };
  }

  return { message: String(error) };
}

export function serializeUsage(value: unknown): Record<string, unknown> | null {
  return toJsonRecord(value);
}
