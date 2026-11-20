/**
 * Sanctioned re-export of the gateway error type.
 *
 * `ModelGatewayError` is a value (callers need `ModelGatewayError.isInstance`
 * to classify failures), so it cannot be pulled in with `import type`. It also
 * carries no way to reach a model: it is a plain error class, so re-exporting
 * it opens no path around billing. Routing it through the gateway boundary
 * keeps the "only src/shared/model-gateway/** talks to the package" invariant
 * intact without forcing an exemption on every module that maps gateway
 * failures onto its own error shape.
 *
 * Deliberately a leaf module rather than an addition to `client.ts`: modules
 * that only need to classify an error should not have to drag the billed
 * client (and its db/billing dependencies) in with it.
 */
import { normalizeGatewayError } from "@sourceweft/model-gateway";

export { ModelGatewayError } from "@sourceweft/model-gateway";

/**
 * Whether a gateway call ended in a timeout: the request's own deadline (a
 * fetch abort) or a classified `TIMEOUT` surfaced after failover. A pure
 * classifier, so it opens no path around billing either.
 */
export function isModelGatewayTimeout(error: unknown): boolean {
  return normalizeGatewayError(error).code === "TIMEOUT";
}
