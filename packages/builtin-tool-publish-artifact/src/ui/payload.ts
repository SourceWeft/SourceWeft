/**
 * Payload reading for this capability's stored artifact rows.
 *
 * The generic preview panel hands the payload over untouched; how to read a
 * deck's keys out of it is the publisher's business.
 */
export function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
