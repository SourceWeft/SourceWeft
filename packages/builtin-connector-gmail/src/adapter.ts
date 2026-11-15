import { Buffer } from "node:buffer";
import type { ComposioBroker } from "@sourceweft/connector-broker-composio";
import { ComposioBrokerError } from "@sourceweft/connector-broker-composio";
import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorAuthorizationFinishInput,
  ConnectorAuthorizationStartInput,
  ConnectorDiscoverInput,
  ConnectorDiscoveryPage,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "@sourceweft/contracts";
import { toBackendGmailComposioManifest, toBackendGmailManifest } from "./backend-manifest";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "./contribution";
import {
  createComposioTransport,
  createGoogleDirectTransport,
  decodeComposioCredential,
  encodeComposioCredential,
  GmailAdapterError,
  type GmailTransport,
  type GmailTransportResponse,
} from "./transport";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export { GmailAdapterError };

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
  headers?: GmailHeader[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  labelIds?: string[];
  payload?: GmailPart;
  sizeEstimate?: number;
};
type GmailList = {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
};
type GmailHistory = {
  historyId?: string;
  nextPageToken?: string;
  history?: Array<{
    messagesAdded?: Array<{ message?: { id?: string } }>;
    messagesDeleted?: Array<{ message?: { id?: string } }>;
    labelsAdded?: Array<{ message?: { id?: string } }>;
    labelsRemoved?: Array<{ message?: { id?: string } }>;
  }>;
};

export type GmailAdapterConfig =
  | {
      mode: "google";
      baseUrl: string;
      redirectUri?: string;
      clientId: string;
      clientSecret: string;
      fetcher?: typeof fetch;
    }
  | {
      mode: "composio";
      baseUrl: string;
      broker: ComposioBroker | null;
    };

function composioConfigMissingError(): GmailAdapterError {
  return new GmailAdapterError(
    500,
    "CONNECTOR_OAUTH_CONFIG_MISSING",
    "Gmail is not configured: COMPOSIO_API_KEY is missing",
  );
}

function modeUnsupported(): never {
  throw new GmailAdapterError(
    501,
    "GMAIL_MODE_UNSUPPORTED",
    "Gmail via Composio does not support this operation",
  );
}

/**
 * Translate a Composio broker failure raised by one of the authorization
 * calls (`createLink`, `getConnectedAccount`, `deleteConnectedAccount`) into a
 * terminal, user-facing `GmailAdapterError`. Composio-side trouble the user
 * cannot act on becomes a 503 `GMAIL_UNAVAILABLE`; an inactive/unknown
 * connection seen while finishing means the consent never completed, so (only
 * there) it becomes a 409 `GMAIL_AUTHORIZATION_INCOMPLETE`. Anything that is
 * not a `ComposioBrokerError` (a `GmailAdapterError` we raised ourselves, a
 * programming error) is returned unchanged for the caller to rethrow.
 */
function translateComposioAuthError(
  error: unknown,
  options: { inactiveIsIncomplete?: boolean } = {},
): unknown {
  if (error instanceof ComposioBrokerError) {
    if (
      options.inactiveIsIncomplete &&
      error.code === "COMPOSIO_CONNECTION_INACTIVE"
    ) {
      return new GmailAdapterError(
        409,
        "GMAIL_AUTHORIZATION_INCOMPLETE",
        "Gmail authorization is not active yet",
      );
    }
    return new GmailAdapterError(
      503,
      "GMAIL_UNAVAILABLE",
      "Gmail is temporarily unavailable",
    );
  }
  return error;
}

function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !MESSAGE_ID.test(value)) {
    throw new GmailAdapterError(400, "GMAIL_INVALID_ID", `Invalid ${label}`);
  }
  return value;
}

function safeString(value: unknown, max = 10000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function header(part: GmailPart | undefined, name: string): string {
  return (
    part?.headers?.find(
      (entry) => entry.name?.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
  );
}

function decodeBase64Url(value: string): string {
  if (value.length > 400000) {
    throw new GmailAdapterError(
      413,
      "GMAIL_BODY_TOO_LARGE",
      "Gmail message body exceeds the supported size",
    );
  }
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function safeHtmlText(value: string): string {
  return value
    .replace(/<(script|style|iframe|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\n[ \t]*\n[ \t]*\n/g, "\n\n")
    .trim();
}

function bodyText(part: GmailPart | undefined): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const visit = (current: GmailPart) => {
    if (current.body?.attachmentId) return;
    if (current.body?.data) {
      const decoded = decodeBase64Url(current.body.data);
      if (current.mimeType === "text/plain") plain.push(decoded);
      if (current.mimeType === "text/html") html.push(safeHtmlText(decoded));
    }
    for (const child of current.parts ?? []) visit(child);
  };
  visit(part);
  const result = plain.length ? plain.join("\n\n") : html.join("\n\n");
  if (result.length > 200000) {
    throw new GmailAdapterError(
      413,
      "GMAIL_BODY_TOO_LARGE",
      "Gmail message body exceeds the supported size",
    );
  }
  return result;
}

function gmailUrl(message: GmailMessage, email: string): string {
  const threadId = assertId(message.threadId ?? message.id, "thread ID");
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${threadId}`;
}

function messageMetadata(message: GmailMessage, email: string) {
  const messageId = assertId(message.id, "message ID");
  return {
    messageId,
    threadId: assertId(message.threadId, "thread ID"),
    citationKey: `gmail:${email.toLowerCase()}:${messageId}`,
    subject:
      safeString(header(message.payload, "Subject"), 998) || "(no subject)",
    from: safeString(header(message.payload, "From"), 1000),
    to: safeString(header(message.payload, "To"), 2000),
    cc: safeString(header(message.payload, "Cc"), 2000),
    date: safeString(header(message.payload, "Date"), 300),
    internalDate: message.internalDate ?? null,
    labels: (message.labelIds ?? []).filter(
      (value) => typeof value === "string",
    ),
    snippet: safeString(message.snippet, 500),
    url: gmailUrl(message, email),
  };
}

function toItem(message: GmailMessage, email: string): ConnectorItem {
  const metadata = messageMetadata(message, email);
  return {
    externalId: metadata.messageId,
    externalUri: metadata.url,
    title: metadata.subject,
    mimeType: "text/plain",
    sizeBytes:
      typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
    externalUpdatedAt: message.internalDate
      ? new Date(Number(message.internalDate))
      : null,
    contentHash: null,
    metadata,
  };
}

function selected(
  message: GmailMessage,
  config: Record<string, unknown>,
): boolean {
  const labelIds = Array.isArray(config.labelIds)
    ? config.labelIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (
    labelIds.length &&
    !labelIds.some((label) => message.labelIds?.includes(label))
  ) {
    return false;
  }
  if (typeof config.after === "string") {
    const after = Date.parse(config.after);
    if (!Number.isFinite(after)) {
      throw new GmailAdapterError(
        400,
        "GMAIL_INVALID_DATE",
        "Invalid Gmail indexing start date",
      );
    }
    if (!message.internalDate || Number(message.internalDate) < after)
      return false;
  }
  return !(message.labelIds ?? []).some(
    (label) => label === "TRASH" || label === "SPAM" || label === "DRAFT",
  );
}

function maxMessages(config: Record<string, unknown>): number {
  const value = config.maxMessages;
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(10000, value))
    : 500;
}

function recipients(
  value: unknown,
  label: string,
  required: boolean,
): string[] {
  if (value === undefined && !required) return [];
  if (
    !Array.isArray(value) ||
    (required && value.length === 0) ||
    value.length > 20
  ) {
    throw new GmailAdapterError(
      400,
      "GMAIL_RECIPIENTS_INVALID",
      `Invalid ${label} recipients`,
    );
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length > 320 ||
      /[\r\n<>]/.test(entry) ||
      !/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(entry)
    ) {
      throw new GmailAdapterError(
        400,
        "GMAIL_RECIPIENTS_INVALID",
        `Invalid ${label} recipient`,
      );
    }
    return entry;
  });
}

function sendRaw(request: Record<string, unknown>, sender: string): string {
  const to = recipients(request.to, "To", true);
  const cc = recipients(request.cc, "Cc", false);
  const bcc = recipients(request.bcc, "Bcc", false);
  const subject = request.subject;
  const body = request.body;
  if (
    typeof subject !== "string" ||
    !subject.trim() ||
    subject.length > 998 ||
    /[\r\n]/.test(subject)
  ) {
    throw new GmailAdapterError(
      400,
      "GMAIL_SUBJECT_INVALID",
      "Invalid email subject",
    );
  }
  if (typeof body !== "string" || !body.trim() || body.length > 100000) {
    throw new GmailAdapterError(
      400,
      "GMAIL_BODY_INVALID",
      "Invalid email body",
    );
  }
  const encodedSubject = /[^\x20-\x7E]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`
    : subject;
  const lines = [
    `From: ${sender}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body.replace(/\r?\n/g, "\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function cursorPart(
  input: ConnectorDiscoverInput,
  key: "committed" | "continuation",
) {
  const value = input.cursor?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createGmailConnectorAdapter(
  config: GmailAdapterConfig,
): ConnectorAdapter {
  const transport: GmailTransport =
    config.mode === "composio"
      ? config.broker
        ? createComposioTransport(config.broker)
        : async () => {
            throw composioConfigMissingError();
          }
      : createGoogleDirectTransport(config.fetcher ?? fetch);

  async function providerRequest<T>(
    url: string,
    credential: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const retryableMethod = !init.method || init.method === "GET";
    for (let attempt = 0; attempt < (retryableMethod ? 3 : 1); attempt += 1) {
      let result: GmailTransportResponse;
      try {
        result = await transport(url, credential, init);
      } catch (error) {
        // A GmailAdapterError thrown by the transport is already a final,
        // classified outcome (e.g. a non-retryable Composio failure or a
        // missing-broker configuration error): it is rethrown unchanged
        // rather than retried. Anything else is treated as the existing
        // network-failure branch.
        if (error instanceof GmailAdapterError) {
          throw error;
        }
        if (retryableMethod && attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 250 * 2 ** attempt),
          );
          continue;
        }
        throw new GmailAdapterError(
          503,
          "GMAIL_UNAVAILABLE",
          "Gmail is unavailable",
        );
      }
      if (result.status >= 200 && result.status < 300)
        return result.body as T;
      const retryableStatus = result.status === 429 || result.status >= 500;
      if (retryableMethod && retryableStatus && attempt < 2) {
        const delay =
          result.retryAfterSeconds && result.retryAfterSeconds > 0
            ? Math.min(5000, result.retryAfterSeconds * 1000)
            : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      const code =
        result.status === 401
          ? "GMAIL_REAUTH_REQUIRED"
          : result.status === 403
            ? "GMAIL_ACCESS_DENIED"
            : result.status === 404
              ? "GMAIL_NOT_FOUND"
              : result.status === 429
                ? "GMAIL_RATE_LIMITED"
                : result.status >= 500
                  ? "GMAIL_UNAVAILABLE"
                  : "GMAIL_REQUEST_FAILED";
      throw new GmailAdapterError(
        result.status,
        code,
        `Gmail request failed (${result.status})`,
      );
    }
    throw new GmailAdapterError(
      503,
      "GMAIL_UNAVAILABLE",
      "Gmail is unavailable",
    );
  }

  async function profile(credential: string) {
    const value = await providerRequest<{
      emailAddress?: string;
      historyId?: string;
    }>(`${API}/profile`, credential);
    if (!value.emailAddress || !value.historyId) {
      throw new GmailAdapterError(
        502,
        "GMAIL_PROFILE_INVALID",
        "Gmail profile is incomplete",
      );
    }
    return { email: value.emailAddress, historyId: value.historyId };
  }

  async function getMessage(
    credential: string,
    id: string,
    format: "metadata" | "full",
  ) {
    return providerRequest<GmailMessage>(
      `${API}/messages/${encodeURIComponent(assertId(id, "message ID"))}?format=${format}`,
      credential,
    );
  }

  async function validateSelectedLabels(input: ConnectorDiscoverInput) {
    const chosen = Array.isArray(input.config.labelIds)
      ? input.config.labelIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (!chosen.length) return;
    const available = await providerRequest<{
      labels?: Array<{ id?: string }>;
    }>(`${API}/labels`, input.accessToken);
    const ids = new Set((available.labels ?? []).map((label) => label.id));
    if (chosen.some((id) => !ids.has(id))) {
      throw new GmailAdapterError(
        409,
        "GMAIL_LABEL_UNAVAILABLE",
        "A selected Gmail label is no longer available; update indexing scope",
      );
    }
  }

  // Shared between modes: Gmail request building and result shaping for
  // every action are identical whether the transport talks to Google
  // directly or through Composio's proxy.
  async function executeAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorActionResult> {
    const action = input.actionType;
    if (action === "gmail.labels.list") {
      const page = await providerRequest<{
        labels?: Array<{ id?: string; name?: string; type?: string }>;
      }>(`${API}/labels`, input.accessToken);
      return {
        result: {
          labels: (page.labels ?? [])
            .filter((label) => label.id && label.name)
            .map((label) => ({
              id: label.id,
              name: label.name,
              type: label.type ?? "user",
            })),
        },
      };
    }
    if (action === "gmail.message.send") {
      const identity = await profile(input.accessToken);
      const raw = sendRaw(input.request, identity.email);
      const sent = await providerRequest<{ id?: string; threadId?: string }>(
        `${API}/messages/send`,
        input.accessToken,
        { method: "POST", body: JSON.stringify({ raw }) },
      );
      if (!sent.id) {
        throw new GmailAdapterError(
          502,
          "GMAIL_SEND_RESULT_INVALID",
          "Gmail did not confirm a sent message ID",
        );
      }
      return {
        externalId: sent.id,
        result: {
          sent: true,
          messageId: sent.id,
          threadId: sent.threadId ?? null,
        },
      };
    }
    if (input.config.liveSearchEnabled === false) {
      throw new GmailAdapterError(
        409,
        "GMAIL_LIVE_DISABLED",
        "Live Gmail search is disabled",
      );
    }
    const identity = await profile(input.accessToken);
    if (action === "gmail.message.search") {
      const query = safeString(input.request.query, 512).trim();
      if (!query)
        throw new GmailAdapterError(
          400,
          "GMAIL_QUERY_REQUIRED",
          "Search query is required",
        );
      const maxResults =
        typeof input.request.maxResults === "number"
          ? Math.min(50, Math.max(1, input.request.maxResults))
          : 20;
      const url = new URL(`${API}/messages`);
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(maxResults));
      if (typeof input.request.pageToken === "string")
        url.searchParams.set("pageToken", input.request.pageToken);
      const page = await providerRequest<GmailList>(
        url.toString(),
        input.accessToken,
      );
      const messages = [];
      for (const ref of page.messages ?? []) {
        if (!ref.id) continue;
        const message = await getMessage(input.accessToken, ref.id, "metadata");
        messages.push(messageMetadata(message, identity.email));
      }
      return {
        result: { messages, nextPageToken: page.nextPageToken ?? null },
      };
    }
    if (action === "gmail.message.read") {
      const message = await getMessage(
        input.accessToken,
        assertId(input.request.messageId, "message ID"),
        "full",
      );
      return {
        result: {
          ...messageMetadata(message, identity.email),
          body: bodyText(message.payload),
        },
      };
    }
    if (action === "gmail.thread.read") {
      const id = assertId(input.request.threadId, "thread ID");
      const thread = await providerRequest<{ messages?: GmailMessage[] }>(
        `${API}/threads/${encodeURIComponent(id)}?format=full`,
        input.accessToken,
      );
      return {
        result: {
          threadId: id,
          messages: (thread.messages ?? []).slice(0, 50).map((message) => ({
            ...messageMetadata(message, identity.email),
            body: bodyText(message.payload),
          })),
          truncated: (thread.messages?.length ?? 0) > 50,
        },
      };
    }
    throw new GmailAdapterError(
      400,
      "GMAIL_ACTION_UNSUPPORTED",
      "Unsupported Gmail action",
    );
  }

  if (config.mode === "composio") {
    const composioConfig = config;
    return {
      capabilityId: "sourceweft/gmail",
      getManifest() {
        return toBackendGmailComposioManifest();
      },
      async exchangeOAuthCode(_input: OAuthCodeExchangeInput) {
        modeUnsupported();
      },
      async refreshOAuthToken(_input: OAuthRefreshInput) {
        modeUnsupported();
      },
      async startAuthorization(input: ConnectorAuthorizationStartInput) {
        if (!composioConfig.broker) throw composioConfigMissingError();
        let link;
        try {
          link = await composioConfig.broker.createLink({
            toolkit: "gmail",
            ownerRef: input.ownerRef,
            callbackUrl: input.callbackUrl,
          });
        } catch (error) {
          throw translateComposioAuthError(error);
        }
        return {
          authorizationUrl: link.authorizationUrl,
          attemptRef: link.connectedAccountId,
        };
      },
      async finishAuthorization(
        input: ConnectorAuthorizationFinishInput,
      ): Promise<OAuthTokenSet> {
        if (!composioConfig.broker) throw composioConfigMissingError();
        if (
          input.callbackParams.status !== "success" ||
          input.callbackParams.connected_account_id !== input.attemptRef
        ) {
          throw new GmailAdapterError(
            400,
            "GMAIL_AUTHORIZATION_INVALID",
            "Gmail authorization was not completed",
          );
        }
        let account;
        try {
          account = await composioConfig.broker.getConnectedAccount(
            input.attemptRef,
          );
        } catch (error) {
          throw translateComposioAuthError(error, { inactiveIsIncomplete: true });
        }
        if (account.status !== "ACTIVE" || account.toolkit !== "gmail") {
          throw new GmailAdapterError(
            409,
            "GMAIL_AUTHORIZATION_INCOMPLETE",
            "Gmail authorization is not active yet",
          );
        }
        const credential = encodeComposioCredential({
          ownerRef: input.ownerRef,
          connectedAccountId: input.attemptRef,
        });
        const identity = await profile(credential);
        return {
          accessToken: credential,
          providerAccountId: identity.email,
          providerAccountEmail: identity.email,
          displayName: identity.email,
          scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE],
        };
      },
      async revokeAuthorization(input: { accessToken: string }) {
        if (!composioConfig.broker) throw composioConfigMissingError();
        const { connectedAccountId } = decodeComposioCredential(
          input.accessToken,
        );
        try {
          await composioConfig.broker.deleteConnectedAccount(connectedAccountId);
        } catch (error) {
          throw translateComposioAuthError(error);
        }
      },
      async checkSyncReadiness() {
        return { ready: false, reason: "indexing_unavailable" };
      },
      discover(_input: ConnectorDiscoverInput): AsyncIterable<ConnectorItem> {
        modeUnsupported();
      },
      discoverPages(
        _input: ConnectorDiscoverInput,
      ): AsyncIterable<ConnectorDiscoveryPage> {
        modeUnsupported();
      },
      async extract(
        _input: ConnectorExtractInput,
      ): Promise<ConnectorExtractedContent> {
        modeUnsupported();
      },
      executeAction,
    };
  }

  const redirectUri =
    config.redirectUri ??
    `${config.baseUrl}/v1/connectors/oauth/gmail/callback`;

  async function tokenRequest(params: URLSearchParams): Promise<OAuthTokenSet> {
    if (config.mode !== "google") {
      modeUnsupported();
    }
    if (!config.clientId || !config.clientSecret) {
      throw new GmailAdapterError(
        500,
        "GMAIL_OAUTH_CONFIG_MISSING",
        "Gmail OAuth client is not configured",
      );
    }
    const fetcher = config.fetcher ?? fetch;
    params.set("client_id", config.clientId);
    params.set("client_secret", config.clientSecret);
    let response: Response;
    try {
      response = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new GmailAdapterError(
        503,
        "GMAIL_OAUTH_UNAVAILABLE",
        "Google OAuth is unavailable",
      );
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new GmailAdapterError(
        retryable ? 503 : 401,
        retryable ? "GMAIL_OAUTH_UNAVAILABLE" : "GMAIL_OAUTH_FAILED",
        retryable
          ? "Google OAuth is unavailable"
          : "Google OAuth authorization failed",
      );
    }
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!payload.access_token) {
      throw new GmailAdapterError(
        502,
        "GMAIL_OAUTH_INVALID",
        "Google OAuth returned no access token",
      );
    }
    const scopes = payload.scope?.split(/\s+/).filter(Boolean);
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: payload.expires_in
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null,
      scopes,
    };
  }

  return {
    capabilityId: "sourceweft/gmail",
    getManifest() {
      // Without both credentials the manifest carries no client id, so the
      // platform refuses to start authorization (CONNECTOR_OAUTH_CONFIG_MISSING)
      // instead of sending the user to Google for a code it cannot exchange.
      return toBackendGmailManifest({
        clientId: config.clientId && config.clientSecret ? config.clientId : "",
        redirectUri,
      });
    },
    async exchangeOAuthCode(input: OAuthCodeExchangeInput) {
      const token = await tokenRequest(
        new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
        }),
      );
      if (!token.scopes?.includes(GMAIL_READ_SCOPE)) {
        throw new GmailAdapterError(
          403,
          "GMAIL_READ_SCOPE_MISSING",
          "Gmail reading permission is required",
        );
      }
      const identity = await profile(token.accessToken);
      return {
        ...token,
        providerAccountId: identity.email,
        providerAccountEmail: identity.email,
        displayName: identity.email,
      };
    },
    async refreshOAuthToken(input: OAuthRefreshInput) {
      return tokenRequest(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
        }),
      );
    },
    async checkSyncReadiness(input: ConnectorDiscoverInput) {
      if (input.config.indexingEnabled !== true) {
        return {
          ready: false,
          reason: "gmail_indexing_disabled",
          message: "Gmail indexing is disabled",
        };
      }
      const labels = input.config.labelIds;
      const after = input.config.after;
      if (
        !Array.isArray(labels) ||
        labels.length === 0 ||
        labels.some((label) => typeof label !== "string" || !label) ||
        typeof after !== "string" ||
        !Number.isFinite(Date.parse(after))
      ) {
        return {
          ready: false,
          reason: "gmail_indexing_scope_required",
          message: "Choose Gmail labels and a start date before syncing",
        };
      }
      return { ready: true };
    },
    async *discover(_input: ConnectorDiscoverInput) {
      // Gmail uses discoverPages so its history checkpoint is durable.
    },
    async *discoverPages(
      input: ConnectorDiscoverInput,
    ): AsyncIterable<ConnectorDiscoveryPage> {
      if (input.config.indexingEnabled !== true) {
        yield { items: [], complete: true };
        return;
      }
      await validateSelectedLabels(input);
      const identity = await profile(input.accessToken);
      const committed = cursorPart(input, "committed");
      const continuation = cursorPart(input, "continuation");
      const baseHistoryId = safeString(committed?.historyId, 128);
      if (baseHistoryId && continuation?.mode !== "full") {
        const start =
          safeString(continuation?.startHistoryId, 128) || baseHistoryId;
        let pageToken = safeString(continuation?.pageToken, 4096);
        while (true) {
          const url = new URL(`${API}/history`);
          url.searchParams.set("startHistoryId", start);
          url.searchParams.set("maxResults", "100");
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          let page: GmailHistory;
          try {
            page = await providerRequest<GmailHistory>(
              url.toString(),
              input.accessToken,
            );
          } catch (error) {
            if (
              error instanceof GmailAdapterError &&
              error.statusCode === 404
            ) {
              break;
            }
            throw error;
          }
          const changed = new Set<string>();
          const deleted = new Set<string>();
          for (const event of page.history ?? []) {
            for (const entry of event.messagesAdded ?? [])
              if (entry.message?.id) changed.add(entry.message.id);
            for (const entry of event.labelsAdded ?? [])
              if (entry.message?.id) changed.add(entry.message.id);
            for (const entry of event.labelsRemoved ?? [])
              if (entry.message?.id) changed.add(entry.message.id);
            for (const entry of event.messagesDeleted ?? [])
              if (entry.message?.id) deleted.add(entry.message.id);
          }
          const items: ConnectorItem[] = [];
          for (const id of changed) {
            if (deleted.has(id)) continue;
            try {
              const message = await getMessage(
                input.accessToken,
                id,
                "metadata",
              );
              if (selected(message, input.config))
                items.push(toItem(message, identity.email));
              else deleted.add(id);
            } catch (error) {
              if (
                error instanceof GmailAdapterError &&
                error.statusCode === 404
              )
                deleted.add(id);
              else throw error;
            }
          }
          pageToken = page.nextPageToken ?? "";
          const complete = !pageToken;
          yield {
            items,
            deletedExternalIds: [...deleted],
            continuation: complete
              ? null
              : { mode: "history", startHistoryId: start, pageToken },
            checkpoint: complete
              ? { historyId: page.historyId ?? identity.historyId }
              : null,
            complete,
          };
          if (complete) return;
        }
      }

      // Initial import or expired history: list the selected newest messages.
      // Reconciliation runs only after the complete bounded scope is applied.
      // A complete full scan reconciles all sources using the *current* run ID.
      // Replaying from the first page after a crash is required so sources
      // applied by an earlier run are seen again before reconcileMissing.
      const startHistoryId = identity.historyId;
      let pageToken = "";
      let selectedCount = 0;
      let scanned = 0;
      const limit = maxMessages(input.config);
      while (true) {
        const url = new URL(`${API}/messages`);
        url.searchParams.set("maxResults", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        if (typeof input.config.after === "string") {
          const date = new Date(input.config.after);
          if (Number.isNaN(date.getTime()))
            throw new GmailAdapterError(
              400,
              "GMAIL_INVALID_DATE",
              "Invalid Gmail indexing start date",
            );
          url.searchParams.set(
            "q",
            `after:${Math.floor(date.getTime() / 1000)}`,
          );
        }
        const page = await providerRequest<GmailList>(
          url.toString(),
          input.accessToken,
        );
        const items: ConnectorItem[] = [];
        for (const ref of page.messages ?? []) {
          if (!ref.id) continue;
          scanned += 1;
          let message: GmailMessage;
          try {
            message = await getMessage(input.accessToken, ref.id, "metadata");
          } catch (error) {
            if (error instanceof GmailAdapterError && error.statusCode === 404)
              continue;
            throw error;
          }
          if (selected(message, input.config)) {
            items.push(toItem(message, identity.email));
            selectedCount += 1;
          }
          if (selectedCount >= limit) break;
          if (scanned >= 100000) {
            throw new GmailAdapterError(
              422,
              "GMAIL_SCOPE_TOO_BROAD",
              "Indexing scope requires a narrower date or label selection",
            );
          }
        }
        pageToken = page.nextPageToken ?? "";
        const complete = !pageToken || selectedCount >= limit;
        yield {
          items,
          continuation: complete
            ? null
            : {
                mode: "full",
                startHistoryId,
                pageToken,
                selectedCount,
                scanned,
              },
          checkpoint: complete ? { historyId: startHistoryId } : null,
          complete,
          reconcileMissing: complete,
        };
        if (complete) return;
      }
    },
    async extract(
      input: ConnectorExtractInput,
    ): Promise<ConnectorExtractedContent> {
      const identity = await profile(input.accessToken);
      const message = await getMessage(
        input.accessToken,
        input.item.externalId,
        "full",
      );
      const metadata = messageMetadata(message, identity.email);
      return {
        item: { ...input.item, metadata },
        contentText: bodyText(message.payload),
        directoryPath: [
          {
            externalId: `gmail:${identity.email}`,
            title: identity.email,
            externalUri: `https://mail.google.com/mail/?authuser=${encodeURIComponent(identity.email)}`,
          },
          {
            externalId: "messages",
            title: "Messages",
          },
        ],
      };
    },
    executeAction,
  };
}
