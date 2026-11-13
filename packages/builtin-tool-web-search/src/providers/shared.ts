export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function wordCount(value: string) {
  const compacted = compactWhitespace(value);
  return compacted ? compacted.split(/\s+/).length : 0;
}

export function truncateMarkdown(markdown: string, maxChars: number) {
  if (markdown.length <= maxChars) {
    return { markdown, truncated: false };
  }
  return {
    markdown: markdown.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
