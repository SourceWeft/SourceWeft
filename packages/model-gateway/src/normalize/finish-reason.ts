import { isRecord } from "../utils/object";

/**
 * Why a model reply ended, read from a LangChain message's
 * `response_metadata` and named as `chat/completions` names it.
 *
 * A `chat/completions` reply carries `finish_reason` (`finishReason` on a v3
 * aggregate). A Responses API reply has no such field: LangChain passes on the
 * response's `status` instead. The mapping is the one LangChain applies to its
 * own stream events: `incomplete` (the output limit, or a content filter; the
 * detail stays in `incomplete_details`) is `length`, `completed` is `stop`
 * whether or not the reply called a tool. Callers act on `length` only.
 */
export function finishReasonFromResponseMetadata(
  responseMetadata: unknown,
): string | undefined {
  if (!isRecord(responseMetadata)) {
    return undefined;
  }
  if (typeof responseMetadata.finish_reason === "string") {
    return responseMetadata.finish_reason;
  }
  if (typeof responseMetadata.finishReason === "string") {
    return responseMetadata.finishReason;
  }
  if (responseMetadata.object !== "response") {
    return undefined;
  }
  if (responseMetadata.status === "incomplete") {
    return "length";
  }
  if (responseMetadata.status === "completed") {
    return "stop";
  }
  return undefined;
}
