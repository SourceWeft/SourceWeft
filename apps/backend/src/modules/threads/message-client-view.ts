import type { MessageRecord } from "../content/types";
import { toObjectRecord } from "../../shared/records";
import { sanitizeThreadMessageMetadataForClient } from "./agent/turn/output-normalizer";
import { reasoningSegmentsWithoutText } from "./turn/trace-metadata";
import { normalizeMcpDisplay } from "./turn/trace-parts";

/**
 * The `/messages` view of a stored message. Storage is not changed: this is
 * a read-time projection, so old rows shrink in the response immediately.
 *
 * Every message gets the client sanitizer (skill-instruction redaction, no
 * `reasoningWrite`). Assistant metadata additionally drops what no client
 * reads and what is a copy of another field:
 *
 * - `meteredLlmCalls` (billing trace; `usage_ledgers` is the ledger),
 * - `reasoning` (continuation base and reasoning CAS; the UI renders the
 *   reasoning render blocks),
 * - `traceEvents`, after backfilling `toolCalls[].mcpDisplay` from them for
 *   old rows whose finalized tool call lost its display data,
 * - `text` on reasoning segments and reasoning trace parts, and `input` on
 *   trace parts (legacy copies of the render blocks and `toolCalls[].input`),
 * - `quoteText` on retrieval citations (byte-identical to `excerpt`).
 */
export function projectThreadMessageForClient(
  message: MessageRecord,
): MessageRecord {
  const metadata = sanitizeThreadMessageMetadataForClient(message.metadata);
  return {
    ...message,
    metadata:
      message.role === "assistant"
        ? projectAssistantMetadataForClient(metadata)
        : metadata,
  };
}

function projectAssistantMetadataForClient(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const {
    meteredLlmCalls: _meteredLlmCalls,
    reasoning: _reasoning,
    traceEvents,
    ...view
  } = metadata;
  const retrieval = toObjectRecord(view.retrieval);
  return {
    ...view,
    ...(Array.isArray(view.toolCalls)
      ? { toolCalls: backfillToolCallMcpDisplay(view.toolCalls, traceEvents) }
      : {}),
    ...(Array.isArray(view.reasoningSegments)
      ? {
          reasoningSegments: reasoningSegmentsWithoutText(
            view.reasoningSegments,
          ),
        }
      : {}),
    ...(Array.isArray(view.traceParts)
      ? { traceParts: view.traceParts.map(tracePartStructureForClient) }
      : {}),
    ...(retrieval
      ? {
          retrieval: {
            ...retrieval,
            ...(Array.isArray(retrieval.citations)
              ? { citations: retrieval.citations.map(citationWithoutQuoteText) }
              : {}),
            ...(Array.isArray(retrieval.availableCitations)
              ? {
                  availableCitations: retrieval.availableCitations.map(
                    citationWithoutQuoteText,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Older finalized tool calls dropped their display data while the explicit
 * trace-event tool call kept it. Recover by exact call identity (id and tool),
 * never by hash, and only where the tool call has no valid display of its own.
 */
function backfillToolCallMcpDisplay(
  toolCalls: unknown[],
  traceEvents: unknown,
) {
  const displays = new Map<
    string,
    {
      tool: string;
      display: NonNullable<ReturnType<typeof normalizeMcpDisplay>>;
    }
  >();
  for (const event of Array.isArray(traceEvents) ? traceEvents : []) {
    const record = toObjectRecord(event);
    const call =
      toObjectRecord(record?.toolCall) ??
      toObjectRecord(toObjectRecord(record?.payload)?.toolCall);
    const display = normalizeMcpDisplay(call?.mcpDisplay);
    if (
      call &&
      typeof call.id === "string" &&
      typeof call.tool === "string" &&
      display
    ) {
      displays.set(call.id, { tool: call.tool, display });
    }
  }
  if (displays.size === 0) {
    return toolCalls;
  }
  return toolCalls.map((item) => {
    const call = toObjectRecord(item);
    if (
      !call ||
      typeof call.id !== "string" ||
      normalizeMcpDisplay(call.mcpDisplay)
    ) {
      return item;
    }
    const known = displays.get(call.id);
    return known && known.tool === call.tool
      ? { ...call, mcpDisplay: known.display }
      : item;
  });
}

function tracePartStructureForClient(part: unknown) {
  const record = toObjectRecord(part);
  if (!record) {
    return part;
  }
  const { input: _input, ...structure } = record;
  // The skill sanitizer maps every part's output, so an output-free part
  // comes back with an explicit `output: undefined`; keep the key absent.
  if (structure.output === undefined) {
    delete structure.output;
  }
  if (structure.kind === "reasoning") {
    const { text: _text, ...reasoningStructure } = structure;
    return reasoningStructure;
  }
  return structure;
}

function citationWithoutQuoteText(citation: unknown) {
  const record = toObjectRecord(citation);
  if (!record || !("quoteText" in record)) {
    return citation;
  }
  const { quoteText: _quoteText, ...rest } = record;
  return rest;
}
