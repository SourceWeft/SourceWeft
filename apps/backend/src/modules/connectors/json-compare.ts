function normalizeJsonComparable(value: unknown): unknown {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeJsonComparable(item);
      return normalized === undefined ? null : normalized;
    });
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeJsonComparable(item)] as const)
      .filter(
        (entry): entry is readonly [string, unknown] =>
          entry[1] !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
  }

  return value;
}

export function stableJsonStringify(value: unknown): string {
  const normalized = normalizeJsonComparable(value);
  if (Array.isArray(normalized)) {
    return `[${normalized.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (normalized && typeof normalized === "object") {
    const entries = Object.entries(normalized as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(normalized);
}

export function jsonValuesEqual(left: unknown, right: unknown) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}
