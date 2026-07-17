import type { ArtifactListItem } from "../sources-hub/types";

export function payloadRecord(artifact: ArtifactListItem) {
  const payload = artifact.payloadJson;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

export function payloadString(
  payload: Record<string, unknown>,
  key: string,
) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function isArtifactPending(artifact: ArtifactListItem) {
  return artifact.status === "pending" || artifact.status === "running";
}
