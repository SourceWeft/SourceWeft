export function normalizeContentTitle(
  value: string | undefined,
  fallback: string,
) {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 200);
}
