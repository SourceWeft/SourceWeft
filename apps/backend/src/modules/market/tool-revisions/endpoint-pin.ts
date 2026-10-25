import { createHash } from "node:crypto";
import type { EndpointPin } from "@sourceweft/market-contracts";

export {
  pinEndpoint,
  pinOrigin,
  sameEndpoint,
  type EndpointPin,
} from "@sourceweft/market-contracts";

/** What is stored in place of the endpoint itself. */
export function endpointKeyHash(pin: EndpointPin): string {
  return createHash("sha256").update(pin.key).digest("hex");
}
