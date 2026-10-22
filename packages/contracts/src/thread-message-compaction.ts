/**
 * Lossless compaction of assistant tool-call outputs in `/messages`.
 *
 * Stored tool outputs repeat state across calls and inside each call:
 *
 * - every sandbox tool output carries the message's sandbox operation timeline
 *   as of that call, so a run with N commands stores O(N²) operations;
 * - a serialized LangChain ToolMessage mirrors its fields (`content`, `name`,
 *   `status`, …) under `lc_kwargs`.
 *
 * The API sends each distinct operation once per message
 * (`metadata.toolCallOperationPool`) with per-call indices
 * (`output.operationRefs`), and lists the `lc_kwargs` keys that equal the
 * output's own field (`output.lcKwargsMirrored`) instead of repeating them.
 * The SDK expands the page back, so clients read the stored shape unchanged.
 */

const OPERATION_POOL_KEY = "toolCallOperationPool";
const OPERATION_REFS_KEY = "operationRefs";
const LC_KWARGS_MIRRORED_KEY = "lcKwargsMirrored";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapToolCallOutputs(
  metadata: Record<string, unknown>,
  map: (output: Record<string, unknown>) => Record<string, unknown>,
) {
  if (!Array.isArray(metadata.toolCalls)) {
    return metadata;
  }
  return {
    ...metadata,
    toolCalls: metadata.toolCalls.map((toolCall: unknown) =>
      isRecord(toolCall) && isRecord(toolCall.output)
        ? { ...toolCall, output: map(toolCall.output) }
        : toolCall,
    ),
  };
}

function compactLcKwargs(output: Record<string, unknown>) {
  const kwargs = output.lc_kwargs;
  if (!isRecord(kwargs)) {
    return output;
  }
  const mirrored: string[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(kwargs)) {
    if (
      key in output &&
      JSON.stringify(output[key]) === JSON.stringify(value)
    ) {
      mirrored.push(key);
    } else {
      rest[key] = value;
    }
  }
  return mirrored.length > 0
    ? { ...output, lc_kwargs: rest, [LC_KWARGS_MIRRORED_KEY]: mirrored }
    : output;
}

function expandLcKwargs(output: Record<string, unknown>) {
  const mirrored = output[LC_KWARGS_MIRRORED_KEY];
  if (!Array.isArray(mirrored) || !isRecord(output.lc_kwargs)) {
    return output;
  }
  const { [LC_KWARGS_MIRRORED_KEY]: _mirrored, ...rest } = output;
  const kwargs: Record<string, unknown> = { ...output.lc_kwargs };
  for (const key of mirrored) {
    if (typeof key === "string" && key in output) {
      kwargs[key] = structuredClone(output[key]);
    }
  }
  return { ...rest, lc_kwargs: kwargs };
}

/** API side: compact one assistant message's metadata for `/messages`. */
export function compactToolCallOutputsForClient(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const pool: unknown[] = [];
  const poolIndex = new Map<string, number>();
  let references = 0;
  const pooled = mapToolCallOutputs(metadata, (output) => {
    if (!Array.isArray(output.operations)) {
      return output;
    }
    const refs = output.operations.map((operation: unknown) => {
      const key = JSON.stringify(operation);
      let index = poolIndex.get(key);
      if (index === undefined) {
        index = pool.length;
        pool.push(operation);
        poolIndex.set(key, index);
      }
      references += 1;
      return index;
    });
    const { operations: _operations, ...rest } = output;
    return { ...rest, [OPERATION_REFS_KEY]: refs };
  });
  // Pool only when operations repeat across calls; otherwise inline is smaller.
  const withOperations = references > pool.length ? pooled : metadata;
  const compacted = mapToolCallOutputs(withOperations, compactLcKwargs);
  return references > pool.length
    ? { ...compacted, [OPERATION_POOL_KEY]: pool }
    : compacted;
}

/** SDK side: restore the stored shape of one message's metadata. */
export function expandToolCallOutputsFromClient(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { [OPERATION_POOL_KEY]: pool, ...rest } = metadata;
  return mapToolCallOutputs(rest, (output) => {
    const lcExpanded = expandLcKwargs(output);
    const refs = lcExpanded[OPERATION_REFS_KEY];
    if (
      !Array.isArray(pool) ||
      !Array.isArray(refs) ||
      !refs.every(
        (index) =>
          Number.isInteger(index) &&
          (index as number) >= 0 &&
          (index as number) < pool.length,
      )
    ) {
      return lcExpanded;
    }
    const { [OPERATION_REFS_KEY]: _refs, ...withoutRefs } = lcExpanded;
    return {
      ...withoutRefs,
      operations: refs.map((index: number) => structuredClone(pool[index])),
    };
  });
}
