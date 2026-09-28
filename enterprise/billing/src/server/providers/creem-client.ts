import { createHmac, timingSafeEqual } from "node:crypto";
import { Creem } from "creem";
import { BillingError } from "../errors";

export type CreemClientOptions = {
  apiKey: string;
  testMode?: boolean;
};

/**
 * Builds a Creem SDK client pointed at the test or live API host. This is
 * the single seam through which every Creem call in this package goes, so
 * the two hosts stay in one place.
 */
export function createCreemClient(options: CreemClientOptions): Creem {
  return new Creem({
    apiKey: options.apiKey,
    serverURL: options.testMode
      ? "https://test-api.creem.io"
      : "https://api.creem.io",
  });
}

/**
 * Generates a Creem customer billing portal link and returns the URL.
 * Throws when Creem's response omits the link so callers never propagate
 * an empty portal URL.
 */
export async function createCreemPortalLink(
  options: CreemClientOptions,
  customerId: string,
): Promise<string> {
  const client = createCreemClient(options);
  const response = await client.customers.generateBillingLinks({
    customerId,
  });

  if (!response.customerPortalLink) {
    throw new BillingError(
      "CREEM_PORTAL_UNAVAILABLE",
      502,
      "Creem did not return a billing portal link",
    );
  }

  return response.customerPortalLink;
}

/**
 * Verifies a Creem webhook signature in constant time. Creem signs the raw
 * request body with HMAC-SHA256 and sends the lowercase hex digest in the
 * `creem-signature` header (see @creem_io/webhook-types generateSignature),
 * so the comparison here uses the same algorithm and encoding.
 *
 * The header is trimmed and lower-cased before comparison so a casing or
 * whitespace difference from the sender never causes a spurious rejection.
 * A length mismatch is rejected before reaching `timingSafeEqual`, which
 * throws (rather than returning false) when its two buffers differ in
 * length; checking first also avoids leaking timing information tied to
 * the header's length.
 */
export function verifyCreemSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) {
    return false;
  }

  const provided = header.trim().toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
