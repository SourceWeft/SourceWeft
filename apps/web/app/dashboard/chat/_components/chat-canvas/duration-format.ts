export function formatCompactDuration(durationMs: number) {
  const totalSeconds = Math.max(1, Math.ceil(durationMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

export function formatThoughtDuration(durationMs: number | null | undefined) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return "Thought for a few seconds";
  }

  return `Thought for ${formatCompactDuration(durationMs)}`;
}
