import { HttpClientError } from "@sourceweft/sdk";

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof HttpClientError) {
    return error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}

/**
 * These two codes mean the connector already reached the desired state, so the
 * caller should treat them as success rather than surfacing an error.
 */
export function isConnectorAlreadyHandledError(error: unknown) {
  return (
    error instanceof HttpClientError &&
    (error.code === "CONNECTOR_ALREADY_EXISTS" ||
      error.code === "CONNECTOR_OAUTH_ACCOUNT_IN_USE")
  );
}
