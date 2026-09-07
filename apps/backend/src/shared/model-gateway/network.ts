import { eq } from "drizzle-orm";
import {
  db,
  modelGatewayConfigVersions,
  modelGatewayProviderConfigs,
} from "@sourceweft/db";
import { ModelGatewayError } from "@sourceweft/model-gateway";
import { config } from "../config";
import { createControlledFetch } from "../security/controlled-fetch";
import {
  checkEndpointUrl,
  EndpointPolicyError,
  parseAllowedInternalOrigins,
  validateEndpointUrl,
  type EndpointPolicy,
} from "../security/endpoint-policy";

/** Only deployment-owned definitions belong in systemBaseUrls, never BYOK input. */
export function llmEndpointPolicy(
  systemBaseUrls: readonly string[],
): EndpointPolicy {
  const enforceAddressChecks = config.endpointAddressChecksEnabled;
  const origins = [...(config.llmAllowedInternalOrigins ?? [])];
  for (const baseUrl of systemBaseUrls) {
    let origin: string;
    try {
      origin = parseAllowedInternalOrigins(
        "System Provider endpoint",
        JSON.stringify([new URL(baseUrl).origin]),
      )[0]!;
    } catch {
      throw new EndpointPolicyError(
        "url",
        "System Provider endpoint is invalid",
      );
    }
    const checked = checkEndpointUrl(baseUrl, {
      enforceAddressChecks,
      allowedInternalOrigins: [origin],
    });
    origins.push(checked.origin);
  }
  return {
    enforceAddressChecks,
    allowedInternalOrigins: [...new Set(origins)],
  };
}

/** Non-secret endpoint permissions do not depend on GLOBAL activation or keys. */
export async function loadLlmEndpointPolicy(): Promise<EndpointPolicy> {
  const rows = await db
    .select({ baseUrl: modelGatewayProviderConfigs.baseUrl })
    .from(modelGatewayProviderConfigs)
    .innerJoin(
      modelGatewayConfigVersions,
      eq(
        modelGatewayProviderConfigs.configVersionId,
        modelGatewayConfigVersions.id,
      ),
    )
    .where(eq(modelGatewayConfigVersions.isActive, true));
  return llmEndpointPolicy(rows.map((row) => row.baseUrl));
}

export async function validateLlmEndpoint(baseUrl: string) {
  return (await validateEndpointUrl(baseUrl, await loadLlmEndpointPolicy()))
    .toString()
    .replace(/\/+$/, "");
}

/** A cached model need not own live connections: each HTTP response owns its
 * request scope until body completion, cancellation or failure. No body copy. */
export function createLlmFetch(
  policy: EndpointPolicy,
): typeof globalThis.fetch {
  return async (input, init) => {
    const requests = createControlledFetch(policy);
    try {
      const response = await requests.fetch(input, init);
      if (!response.body) {
        await requests.close();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              await requests.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            await requests.close();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await requests.close();
          }
        },
      });
      const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperties(result, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      });
      return result;
    } catch (error) {
      await requests.close();
      if (error instanceof EndpointPolicyError) {
        throw new ModelGatewayError({
          code: "POLICY",
          message: error.message,
          retryable: false,
          cause: error,
        });
      }
      throw error;
    }
  };
}
