export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timeout));
  });
}

export function toSseData(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
