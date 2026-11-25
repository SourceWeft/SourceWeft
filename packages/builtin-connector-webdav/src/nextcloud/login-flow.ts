import type {
  ConnectorCredentialFlow,
  ConnectorCredentialInput,
} from "@sourceweft/contracts";
import type { WebDavCredentialFlowDeps } from "../flavor";
import { ENDPOINT_MAX_LENGTH, REQUEST_TIMEOUT_MS } from "../limits";
import { nextcloudEndpoint } from "./endpoint";
import {
  deleteAppPassword,
  MAX_LOGIN_FLOW_BYTES,
  nextcloudRequest,
  NextcloudLoginFlowError,
  resolveFilesUserId,
  type NextcloudTransportLimits,
} from "./ocs";

/** Bounds on the JSON fields these exchanges return. The login name and app
 * password match the platform credential bounds (`connectorCredentialInputSchema`:
 * username ≤ 200, secret ≤ 2000); URLs and tokens get generous caps. A value
 * outside its bound is a malformed body (invalid). */
const MAX_LOGIN_NAME_LENGTH = 200;
const MAX_APP_PASSWORD_LENGTH = 2000;
const MAX_URL_LENGTH = 2048;
const MAX_POLL_TOKEN_LENGTH = 512;

function invalid(): never {
  throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
}

/**
 * Validates a member-supplied Nextcloud server base URL. Mirrors the WebDAV
 * endpoint parser but strips the trailing slash (so a sub-folder base path is
 * kept and the root install becomes just the origin) and throws a fixed,
 * non-echoing Nextcloud error. http(s) only, no userinfo, query or fragment.
 * https is NOT required here: the credentialed fetch scope refuses a non-
 * allowlisted non-https origin, so this layer just lets the scope decide.
 */
function normalizeServerUrl(raw: string): URL {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0 || value.length > ENDPOINT_MAX_LENGTH) invalid();
  // The URL parser silently drops tabs and newlines and encodes spaces, so
  // anything of that kind is refused before parsing.
  if (/[\s\u0000-\u001F\u007F]/.test(value)) invalid();
  if (value.includes("?") || value.includes("#")) invalid();
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(value)?.[1];
  if (authority === undefined || authority.includes("@")) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") invalid();
  if (url.username !== "" || url.password !== "" || url.hostname === "") {
    invalid();
  }
  return url;
}

/** The normalised server base string: origin plus base path, trailing slash
 * stripped. (A URL's `pathname` cannot be emptied for an http(s) scheme — it is
 * re-normalised to `/` — so the slash is stripped from the joined string.) */
function serverBase(server: URL): string {
  return `${server.origin}${server.pathname}`.replace(/\/+$/, "");
}

/**
 * Validates that `value` is an http(s) URL on the same origin as `server` and
 * returns it unchanged (so a login URL keeps its path, and a poll endpoint is
 * posted to exactly as given). A cross-origin or non-http(s) value is rejected —
 * this is what stops an attacker server from pointing the browser or the poller
 * at another origin.
 */
function requireSameOrigin(value: unknown, server: URL): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH
  ) {
    invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") invalid();
  if (url.origin !== server.origin) invalid();
  return value;
}

function requireBoundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    invalid();
  }
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
  }
}

/**
 * The Nextcloud Login Flow v2 credential flow. The platform drives the flow
 * (stores `pending` encrypted, polls, creates the connector); this adapter knows
 * the Nextcloud protocol:
 *  - `start` POSTs `<server>/index.php/login/v2` and returns the browser login
 *    URL plus the poll endpoint and token, after checking both URLs are on the
 *    server's own origin;
 *  - `poll` POSTs the token to the poll endpoint (404 ⇒ pending), and on success
 *    resolves the files user id via OCS and returns the credential and config;
 *  - `discard` best-effort revokes an app password the connector could not use.
 *
 * Every request goes through a credentialed fetch scope opened per call and
 * closed in `finally`; every error is a fixed-code, fixed-message
 * {@link NextcloudLoginFlowError} that echoes no server input, token, password
 * or login name. Nothing here is logged.
 */
export function createNextcloudCredentialFlow(
  deps: WebDavCredentialFlowDeps,
): ConnectorCredentialFlow {
  const { credentialedFetch } = deps;
  const limits: NextcloudTransportLimits = {
    timeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    maxBytes: deps.maxResponseBytes ?? MAX_LOGIN_FLOW_BYTES,
  };

  return {
    async start({ serverUrl }) {
      const server = normalizeServerUrl(serverUrl);
      const base = serverBase(server);
      const scope = credentialedFetch();
      try {
        const { status, text } = await nextcloudRequest(
          scope,
          {
            method: "POST",
            url: `${base}/index.php/login/v2`,
            // User-Agent is set to the app name by the transport; the body is
            // empty, as Login Flow v2 expects.
            body: "",
          },
          limits,
        );
        if (status === 404 || status === 405) {
          throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED");
        }
        if (status === 429 || status >= 500) {
          throw new NextcloudLoginFlowError("NEXTCLOUD_UNREACHABLE");
        }
        if (status !== 200) {
          throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED");
        }
        const parsed = parseJson(text) as {
          poll?: { token?: unknown; endpoint?: unknown };
          login?: unknown;
        } | null;
        const pollEndpoint = requireSameOrigin(parsed?.poll?.endpoint, server);
        const pollToken = requireBoundedString(
          parsed?.poll?.token,
          MAX_POLL_TOKEN_LENGTH,
        );
        const loginUrl = requireSameOrigin(parsed?.login, server);
        return {
          loginUrl,
          pending: { pollEndpoint, pollToken, server: base },
        };
      } finally {
        await scope.close();
      }
    },

    async poll({ pending }) {
      const pollEndpoint = requireBoundedString(
        pending.pollEndpoint,
        MAX_URL_LENGTH,
      );
      const pollToken = requireBoundedString(
        pending.pollToken,
        MAX_POLL_TOKEN_LENGTH,
      );
      const base = requireBoundedString(pending.server, MAX_URL_LENGTH);
      let server: URL;
      try {
        server = new URL(base);
      } catch {
        throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
      }
      // Defence in depth: `start` already checked the poll endpoint's origin, but
      // re-verify it against the pending server here (the pending blob could have
      // been tampered with) so a credential-free poll request still never leaves
      // the server's own origin.
      requireSameOrigin(pollEndpoint, server);
      const scope = credentialedFetch();
      try {
        const { status, text } = await nextcloudRequest(
          scope,
          {
            method: "POST",
            url: pollEndpoint,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `token=${encodeURIComponent(pollToken)}`,
          },
          limits,
        );
        // A 404 (or 410) is "not approved yet" — indistinguishable from a flow
        // the provider has forgotten. Only the backend's own expiry ends a flow.
        if (status === 404 || status === 410) {
          return { status: "pending" };
        }
        if (status === 429 || status >= 500) {
          throw new NextcloudLoginFlowError("NEXTCLOUD_UNREACHABLE");
        }
        if (status !== 200) invalid();
        const parsed = parseJson(text) as {
          server?: unknown;
          loginName?: unknown;
          appPassword?: unknown;
        } | null;
        const returnedServer = requireBoundedString(
          parsed?.server,
          MAX_URL_LENGTH,
        );
        const loginName = requireBoundedString(
          parsed?.loginName,
          MAX_LOGIN_NAME_LENGTH,
        );
        const appPassword = requireBoundedString(
          parsed?.appPassword,
          MAX_APP_PASSWORD_LENGTH,
        );
        // The returned server must be the same origin the flow began with, so a
        // server cannot re-point the connector elsewhere. Everything is then
        // built from the server WE normalised (`base`), never the returned path,
        // so a same-origin path trick cannot change where the connector talks.
        let returned: URL;
        try {
          returned = new URL(returnedServer);
        } catch {
          throw new NextcloudLoginFlowError("NEXTCLOUD_LOGIN_FLOW_INVALID");
        }
        if (returned.origin !== server.origin) invalid();

        const userId = await resolveFilesUserId(
          scope,
          { server: base, loginName, appPassword },
          limits,
        );
        const credential: ConnectorCredentialInput = {
          username: loginName,
          secret: appPassword,
        };
        return {
          status: "authorized",
          credential,
          config: {
            server: base,
            endpoint: nextcloudEndpoint(base, userId),
            userId,
          },
        };
      } finally {
        await scope.close();
      }
    },

    async discard({ config, credential }) {
      const server = typeof config.server === "string" ? config.server : null;
      const endpoint =
        typeof config.endpoint === "string" ? config.endpoint : null;
      if (server === null || endpoint === null) return;
      // Only ever revoke at the credential's own endpoint origin. The OCS delete
      // addresses `config.server`; if that was tampered to another origin (a
      // config PATCH that slipped past the backend lock), the origins differ and
      // discard is a no-op, so the app password is never sent anywhere but where
      // it is used.
      let serverOrigin: string;
      let endpointOrigin: string;
      try {
        serverOrigin = new URL(server).origin;
        endpointOrigin = new URL(endpoint).origin;
      } catch {
        return;
      }
      if (serverOrigin !== endpointOrigin) return;
      try {
        const scope = credentialedFetch();
        try {
          await deleteAppPassword(
            scope,
            {
              server,
              username: credential.username,
              secret: credential.secret,
            },
            limits,
          );
        } finally {
          await scope.close();
        }
      } catch {
        // Best-effort: swallow every error (network, policy, bad response). An
        // orphan app password on the member's Nextcloud is acceptable (they can
        // remove it in security settings) and nothing here is logged.
      }
    },
  };
}
