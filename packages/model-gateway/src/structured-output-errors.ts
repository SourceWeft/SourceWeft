import { isRecord } from "./utils/object";

const LENGTH_FINISH_REASON_MESSAGE =
  "Could not parse response content as the length limit was reached";
const CONTENT_FILTER_FINISH_REASON_MESSAGE =
  "Could not parse response content as the request was rejected by the content filter";

/**
 * The finish reason behind the OpenAI SDK's refusal to parse a `json_schema`
 * answer. `chat.completions.parse` (which LangChain uses for every non-stream
 * `json_schema` request) throws `LengthFinishReasonError` /
 * `ContentFilterFinishReasonError` instead of returning the message.
 */
export function unparsedFinishReason(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const className = (error as { constructor?: { name?: unknown } }).constructor
    ?.name;
  const message = typeof error.message === "string" ? error.message : "";
  if (
    className === "LengthFinishReasonError" ||
    message.includes(LENGTH_FINISH_REASON_MESSAGE)
  ) {
    return "length";
  }
  if (
    className === "ContentFilterFinishReasonError" ||
    message.includes(CONTENT_FILTER_FINISH_REASON_MESSAGE)
  ) {
    return "content_filter";
  }
  return undefined;
}

/**
 * Whether the SDK rejected a structured answer it had received: a finish
 * reason it cannot parse, or a `SyntaxError` raised by its own answer parser
 * (`parseChatCompletion` / `parseResponseFormat` in the stack). The request
 * reached the model and was answered, so sending it again at the transport
 * level repeats a billed call for, very likely, the same answer; the caller's
 * retry loop owns that decision. A `SyntaxError` from anywhere else (a garbled
 * response body) is not matched and keeps the transport retry.
 */
export function isUnparsedStructuredAnswer(error: unknown): boolean {
  if (unparsedFinishReason(error) !== undefined) return true;
  if (!isRecord(error) || error.name !== "SyntaxError") return false;
  const stack = typeof error.stack === "string" ? error.stack : "";
  return /\bparse(?:ChatCompletion|ResponseFormat)\b/u.test(stack);
}
