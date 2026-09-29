import {
  resolveSystemModelIdentity,
  withSystemModel,
} from "../../shared/model-gateway/system-client";
import { overviewModelConfigurationKey } from "./keys";
import type {
  OverviewModelCall,
  OverviewModelSpec,
  OverviewPrompt,
} from "./types";

/**
 * The model side of an overview: the structured call through the system
 * model, and the configured model's key.
 */

/**
 * The model call through the system model: no tools, a JSON schema to answer
 * in (the prompt's own when it carries one, else the kind's static one),
 * thinking pinned off (DeepSeek thinks by default, and a forced
 * structured-output tool choice is refused while it does), output capped.
 * `spec` is usually the kind's adapter.
 */
export function createOverviewModelCall<TPrompt extends OverviewPrompt>(
  spec: OverviewModelSpec,
): OverviewModelCall<TPrompt> {
  return async ({ prompt, versionId, scopeId }) => {
    const result = await withSystemModel(
      {
        purpose: spec.purpose,
        subjectRef: spec.subjectRef(versionId),
        scopeId,
      },
      (chat) =>
        chat.complete({
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          structuredOutput: {
            name: spec.output.name,
            description: spec.output.description,
            schema: prompt.outputSchema ?? spec.output.schema,
          },
          thinking: { mode: "off", enabled: false, includeReasoning: false },
          maxTokens: spec.output.maxTokens,
          temperature: 0.2,
        }),
    );
    const output = result.structuredOutput ?? textOf(result.raw?.content);
    return {
      output,
      model: result.providerModel ?? result.model,
    };
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && typeof part.text === "string"
            ? part.text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * The key analyses from the configured system model are stored under, so a
 * change of model or endpoint makes earlier results stale while a key
 * rotation does not. Null while the system model is not configured.
 */
export async function resolveOverviewModelConfigurationKey(): Promise<
  string | null
> {
  const identity = await resolveSystemModelIdentity();
  return identity ? overviewModelConfigurationKey(identity) : null;
}
