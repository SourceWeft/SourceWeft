"use client";

export const CONNECTOR_OAUTH_CHANNEL = "sourceweft-connectors-oauth";
export const CONNECTOR_OAUTH_STORAGE_KEY = "sourceweft:connectors:oauth";

export type ConnectorOAuthCompletionMessage = {
  id: string;
  workspaceId: string;
  connectorType: string;
  accountId: string | null;
  status: "success" | "error";
  error?: string | null;
  createdAt: string;
};

export function publishConnectorOAuthCompletion(
  message: ConnectorOAuthCompletionMessage,
) {
  try {
    const channel = new BroadcastChannel(CONNECTOR_OAUTH_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    // BroadcastChannel is not available in every embedded browser.
  }

  try {
    localStorage.setItem(CONNECTOR_OAUTH_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // The completion page still renders a manual return state.
  }
}

export function parseConnectorOAuthCompletionMessage(
  value: unknown,
): ConnectorOAuthCompletionMessage | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as Partial<ConnectorOAuthCompletionMessage>;
  if (
    typeof maybe.id !== "string" ||
    typeof maybe.workspaceId !== "string" ||
    typeof maybe.connectorType !== "string" ||
    (maybe.accountId !== null && typeof maybe.accountId !== "string") ||
    (maybe.status !== "success" && maybe.status !== "error") ||
    typeof maybe.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: maybe.id,
    workspaceId: maybe.workspaceId,
    connectorType: maybe.connectorType,
    accountId: maybe.accountId,
    status: maybe.status,
    error: typeof maybe.error === "string" ? maybe.error : null,
    createdAt: maybe.createdAt,
  };
}

