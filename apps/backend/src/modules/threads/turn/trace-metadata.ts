import {
  normalizeTraceParts,
  upsertTracePart,
  type TracePart,
} from "./trace-parts";

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getTraceItemId(item: unknown) {
  return getObjectRecord(item)?.id;
}

function getTraceItemDisplayOrder(item: unknown) {
  const displayOrder = getObjectRecord(item)?.displayOrder;
  return typeof displayOrder === "number" && Number.isFinite(displayOrder)
    ? displayOrder
    : null;
}

function getTraceItemSequence(item: unknown) {
  const sequence = getObjectRecord(item)?.sequence;
  return typeof sequence === "number" && Number.isFinite(sequence)
    ? sequence
    : null;
}

function preserveTraceItemState(existing: unknown, next: unknown) {
  const existingRecord = getObjectRecord(existing);
  const nextRecord = getObjectRecord(next);
  if (!existingRecord || !nextRecord) {
    return next;
  }
  return {
    ...nextRecord,
    ...(nextRecord.approvalState === undefined &&
    existingRecord.approvalState !== undefined
      ? { approvalState: existingRecord.approvalState }
      : {}),
    ...(nextRecord.approvalConfirmationId === undefined &&
    existingRecord.approvalConfirmationId !== undefined
      ? { approvalConfirmationId: existingRecord.approvalConfirmationId }
      : {}),
  };
}

function replaceTraceItemPreservingSequence(existing: unknown, next: unknown) {
  const nextRecord = getObjectRecord(preserveTraceItemState(existing, next));
  if (!nextRecord) {
    return next;
  }

  const sequence = getTraceItemSequence(existing);
  return sequence === null
    ? nextRecord
    : {
        ...nextRecord,
        sequence,
      };
}

function appendTraceItemsByEventId(
  existing: unknown,
  next: unknown,
  options: { preserveDisplayOrder?: boolean } = {},
) {
  const existingItems = Array.isArray(existing) ? existing : [];
  const nextItems = Array.isArray(next) ? next : [];
  if (nextItems.length === 0) {
    return existingItems;
  }

  const output = options.preserveDisplayOrder
    ? existingItems.map((item, index) => {
        const itemRecord = getObjectRecord(item);
        return itemRecord
          ? {
              ...itemRecord,
              displayOrder: getTraceItemDisplayOrder(itemRecord) ?? index,
            }
          : item;
      })
    : [...existingItems];
  const indexesById = new Map<string, number>();
  output.forEach((item, index) => {
    const id = getTraceItemId(item);
    if (typeof id === "string" && id.length > 0) {
      indexesById.set(id, index);
    }
  });

  for (const item of nextItems) {
    const id = getTraceItemId(item);
    if (typeof id === "string" && indexesById.has(id)) {
      const existingIndex = indexesById.get(id)!;
      const itemRecord = getObjectRecord(item);
      output[existingIndex] =
        options.preserveDisplayOrder && itemRecord
          ? {
              ...itemRecord,
              displayOrder:
                getTraceItemDisplayOrder(output[existingIndex]) ??
                existingIndex,
            }
          : item;
      continue;
    }
    if (typeof id === "string" && id.length > 0) {
      indexesById.set(id, output.length);
    }
    const itemRecord = getObjectRecord(item);
    output.push(
      options.preserveDisplayOrder && itemRecord
        ? {
            ...itemRecord,
            displayOrder: output.length,
          }
        : item,
    );
  }

  return output;
}

function appendTraceItemsByStateId(existing: unknown, next: unknown) {
  const existingItems = Array.isArray(existing) ? existing : [];
  const nextItems = Array.isArray(next) ? next : [];
  if (nextItems.length === 0) {
    return existingItems;
  }

  const output = [...existingItems];
  const indexesById = new Map<string, number>();
  output.forEach((item, index) => {
    const id = getTraceItemId(item);
    if (typeof id === "string" && id.length > 0) {
      indexesById.set(id, index);
    }
  });

  for (const item of nextItems) {
    const id = getTraceItemId(item);
    if (typeof id === "string" && indexesById.has(id)) {
      const existingIndex = indexesById.get(id)!;
      output[existingIndex] = replaceTraceItemPreservingSequence(
        output[existingIndex],
        item,
      );
      continue;
    }
    if (typeof id === "string" && id.length > 0) {
      indexesById.set(id, output.length);
    }
    output.push(item);
  }

  return output;
}

function appendReasoningSegments(existing: unknown, next: unknown) {
  const existingItems = Array.isArray(existing) ? existing : [];
  const nextItems = Array.isArray(next) ? next : [];
  return appendTraceItemsByStateId(existingItems, nextItems);
}

function appendReasoningText(existing: unknown, next: unknown) {
  if (typeof existing !== "string" || existing.length === 0) {
    return next;
  }
  if (typeof next !== "string" || next.length === 0) {
    return existing;
  }
  if (existing === next || existing.endsWith(next)) {
    return existing;
  }
  if (next.startsWith(existing)) {
    return next;
  }
  return `${existing}\n${next}`;
}

function appendTraceParts(existing: unknown, next: unknown) {
  return normalizeTraceParts(next).reduce<TracePart[]>(
    (parts, part) => upsertTracePart(parts, part),
    normalizeTraceParts(existing),
  );
}

function areRenderBlocksEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendRenderBlocks(existing: unknown, next: unknown) {
  const existingItems = Array.isArray(existing) ? existing : [];
  const nextItems = Array.isArray(next) ? next : [];
  if (nextItems.length === 0) {
    return existingItems;
  }
  if (existingItems.length === 0) {
    return nextItems;
  }
  if (
    existingItems.every((item, index) =>
      areRenderBlocksEqual(item, nextItems[index]),
    )
  ) {
    return nextItems;
  }

  const usedIds = new Set<string>();
  for (const item of existingItems) {
    const id = getTraceItemId(item);
    if (typeof id === "string" && id.length > 0) {
      usedIds.add(id);
    }
  }

  return [
    ...existingItems,
    ...nextItems.map((item, index) => {
      const record = getObjectRecord(item);
      const id = typeof record?.id === "string" ? record.id : null;
      if (!record || !id || !usedIds.has(id)) {
        if (id) {
          usedIds.add(id);
        }
        return item;
      }
      const nextId = `${id}:continued-${existingItems.length + index + 1}`;
      usedIds.add(nextId);
      return {
        ...record,
        id: nextId,
      };
    }),
  ];
}

export function preserveTraceMetadata(input: {
  existingMetadata?: Record<string, unknown> | null;
  nextMetadata: Record<string, unknown>;
}) {
  const existingMetadata = input.existingMetadata;
  if (!existingMetadata) {
    return input.nextMetadata;
  }

  return {
    ...existingMetadata,
    ...input.nextMetadata,
    reasoning: appendReasoningText(
      existingMetadata.reasoning,
      input.nextMetadata.reasoning,
    ),
    traceEvents: appendTraceItemsByEventId(
      existingMetadata.traceEvents,
      input.nextMetadata.traceEvents,
      { preserveDisplayOrder: true },
    ),
    traceParts: appendTraceParts(
      existingMetadata.traceParts,
      input.nextMetadata.traceParts,
    ),
    reasoningSegments: appendReasoningSegments(
      existingMetadata.reasoningSegments,
      input.nextMetadata.reasoningSegments,
    ),
    toolCalls: appendTraceItemsByStateId(
      existingMetadata.toolCalls,
      input.nextMetadata.toolCalls,
    ),
    thinkingSteps: appendTraceItemsByStateId(
      existingMetadata.thinkingSteps,
      input.nextMetadata.thinkingSteps,
    ),
    renderBlocks:
      input.nextMetadata.renderBlocks !== undefined
        ? input.nextMetadata.renderBlocks
        : existingMetadata.renderBlocks,
  };
}
