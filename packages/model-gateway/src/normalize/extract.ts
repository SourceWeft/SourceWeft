import { isRecord } from "./protocols/openai-compatible";

export function extractRawUsage(
  input: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > 8) {
    return undefined;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const usage = extractRawUsage(item, depth + 1);
      if (usage) {
        return usage;
      }
    }
    return undefined;
  }
  if (!isRecord(input)) {
    return undefined;
  }

  if (isRecord(input.usage)) {
    return input.usage;
  }

  const rawResponse =
    (isRecord(input.__raw_response) ? input.__raw_response : undefined) ??
    (isRecord(input.raw_response) ? input.raw_response : undefined) ??
    (isRecord(input.rawResponse) ? input.rawResponse : undefined);
  if (isRecord(rawResponse?.usage)) {
    return rawResponse.usage;
  }

  for (const key of [
    "__raw_response",
    "raw_response",
    "rawResponse",
    "additional_kwargs",
    "response_metadata",
    "kwargs",
    "message",
    "choices",
    "delta",
  ]) {
    const usage = extractRawUsage(input[key], depth + 1);
    if (usage) {
      return usage;
    }
  }

  return undefined;
}
