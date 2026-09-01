import type {
  ProviderRequestContext,
  ProviderRequestPatch,
} from "../../../observation/types";
import { isRecord } from "../../../normalize/protocols/openai-compatible";

const INCLUDE_COST_HEADER = "X-OrcaRouter-Include-Cost";

export function decorateOrcaRouterRequest(
  context: ProviderRequestContext,
): ProviderRequestPatch {
  const existingStreamOptions = isRecord(context.extraBody?.stream_options)
    ? context.extraBody.stream_options
    : {};

  return {
    headers: { [INCLUDE_COST_HEADER]: "true" },
    ...(context.stream
      ? {
          extraBody: {
            ...(context.extraBody ?? {}),
            stream_options: {
              ...existingStreamOptions,
              include_usage: true,
            },
          },
        }
      : {}),
  };
}
