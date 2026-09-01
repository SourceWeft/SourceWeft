import { getProviderResponseAdapter } from "../adapters/providers/registry";
import type { ChatCompleteInput, ResolvedRequestTarget } from "../types";

export function decorateProviderChatRequest(input: {
  target: ResolvedRequestTarget;
  payload: ChatCompleteInput;
}) {
  const adapter = getProviderResponseAdapter(input.target.provider);
  const patch = adapter?.decorateRequest?.({
    target: input.target,
    modality: "chat",
    stream: input.payload.stream === true,
    extraBody: input.payload.extraBody,
  });
  if (!patch) {
    return input;
  }
  return {
    target: patch.headers
      ? {
          ...input.target,
          defaultHeaders: {
            ...input.target.defaultHeaders,
            ...patch.headers,
          },
        }
      : input.target,
    payload: patch.extraBody
      ? { ...input.payload, extraBody: patch.extraBody }
      : input.payload,
  };
}
