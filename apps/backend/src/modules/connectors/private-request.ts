import { createHmac } from "node:crypto";
import { config } from "../../shared/config";
import { stableJsonStringify } from "./json-compare";

export const ENCRYPTED_REQUEST_KEY = "__connectorEncryptedRequest";
export const BOUND_ACCOUNT_KEY = "__connectorOAuthAccountId";
export const REQUEST_HASH_KEY = "__connectorRequestHash";

export function privateRequestDigest(
  teamId: string,
  request: Record<string, unknown>,
) {
  return createHmac("sha256", config.modelGatewayEncryptionSecret)
    .update(teamId)
    .update(stableJsonStringify(request))
    .digest("hex");
}

export function privateRequestMatches(
  stored: Record<string, unknown>,
  request: Record<string, unknown>,
  teamId: string,
) {
  return stored[REQUEST_HASH_KEY] === privateRequestDigest(teamId, request);
}
