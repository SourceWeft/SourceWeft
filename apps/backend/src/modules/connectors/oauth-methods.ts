import type { ConnectorAdapter } from "@sourceweft/contracts/connectors";
import { ConnectorError } from "./errors";

/**
 * The standard OAuth2 token calls are optional on `ConnectorAdapter` (a `none`
 * or brokered adapter has none). Callers that reach them resolve both here, so
 * a missing method is a typed 500 instead of a `TypeError`.
 */
export function requireOAuthMethods(
  adapter: ConnectorAdapter,
  connectorType: string,
): {
  exchangeOAuthCode: NonNullable<ConnectorAdapter["exchangeOAuthCode"]>;
  refreshOAuthToken: NonNullable<ConnectorAdapter["refreshOAuthToken"]>;
} {
  const { exchangeOAuthCode, refreshOAuthToken } = adapter;
  if (!exchangeOAuthCode || !refreshOAuthToken) {
    throw new ConnectorError(
      500,
      "CONNECTOR_AUTH_KIND_UNSUPPORTED",
      "This connector does not use the standard OAuth2 authorization flow",
      { connectorType },
    );
  }
  return {
    exchangeOAuthCode: exchangeOAuthCode.bind(adapter),
    refreshOAuthToken: refreshOAuthToken.bind(adapter),
  };
}
