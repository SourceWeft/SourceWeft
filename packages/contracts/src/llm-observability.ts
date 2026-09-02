/**
 * Wire shape of an LLM observability payload.
 *
 * A generation's input/output is stored as JSON but reaches the client through
 * a policy layer that may hand back the value already decoded, or hand back the
 * raw JSON text, or hand back a plain string that was never JSON at all (a
 * prompt, a redaction notice, an error message). The reader has to cope with
 * all three, and the backend presenter and the observability dashboard have to
 * cope with them identically or the same generation renders differently
 * depending on which side unwrapped it — which is exactly why this decoder is
 * a contract rather than a helper on either side.
 */

/**
 * Decode a policy-wrapped payload.
 *
 * A non-string is already decoded and passes through. A string is parsed only
 * when it looks like JSON (`{` or `[` after trimming) — a bare prompt is left
 * alone rather than being coerced. Malformed JSON returns the original string
 * instead of throwing: the payload is diagnostic data, and showing the raw text
 * beats failing the panel that displays it.
 */
export function parsePolicyPayload(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}
