export function cloneItems<T extends object>(items: T[]) {
  return items.map((item) => ({ ...item }));
}

export function getThreadWorkfilesCacheKey(
  workspaceId: string,
  threadId: string,
) {
  return `${workspaceId}:${threadId}`;
}
