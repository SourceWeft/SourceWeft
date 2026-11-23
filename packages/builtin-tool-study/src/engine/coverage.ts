/**
 * Orders items so every section is offered once before any section is offered
 * a second time: round-robin over the sections in the order they first appear,
 * each section keeping its own order. Taking items from the front and trimming
 * the surplus from the end then drops repeats of well-covered sections instead
 * of whole sections that happened to come last.
 */
export function coverageFirst<T>(
  items: readonly T[],
  sectionOf: (item: T) => string,
): T[] {
  const queues = new Map<string, T[]>();
  for (const item of items) {
    const section = sectionOf(item);
    const queue = queues.get(section);
    if (queue) queue.push(item);
    else queues.set(section, [item]);
  }
  const ordered: T[] = [];
  const lists = [...queues.values()];
  for (let round = 0; ordered.length < items.length; round += 1) {
    for (const list of lists) {
      const item = list[round];
      if (item !== undefined) ordered.push(item);
    }
  }
  return ordered;
}
