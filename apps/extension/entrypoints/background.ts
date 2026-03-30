import { defineBackground } from "wxt/utils/define-background";

type AuthTokens = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt: number;
  clientId: string;
};

const STORAGE_KEY = "velamind.auth.tokens";
const DEFAULT_SCOPE = "openid profile email offline_access";

type ExtensionEnv = {
  VITE_API_BASE_URL?: string;
  VITE_AUTH_CLIENT_ID?: string;
};

const extensionEnv = (import.meta as unknown as { env?: ExtensionEnv }).env;

function getApiBaseUrl() {
  const value = extensionEnv?.VITE_API_BASE_URL || "http://localhost:3001";
  return value.replace(/\/$/, "");
}

function getClientId() {
  return extensionEnv?.VITE_AUTH_CLIENT_ID || "velamind-extension";
}

function toBase64Url(bytes: Uint8Array) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function pkceChallenge(verifier: string) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
}

async function readTokens() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as AuthTokens | undefined;
  return value || null;
}

async function writeTokens(value: AuthTokens | null) {
  if (!value) {
    await chrome.storage.local.remove(STORAGE_KEY);
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: value });
}

function tokenIsExpired(tokens: AuthTokens, skewMs = 45_000) {
  return Date.now() >= tokens.expiresAt - skewMs;
}

async function exchangeToken(body: URLSearchParams) {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;

  if (!response.ok || !payload?.access_token) {
    throw new Error(
      payload?.error_description ||
        payload?.error ||
        `Token exchange failed (${response.status})`,
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    tokenType: payload.token_type,
    scope: payload.scope,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
  };
}

async function registerPublicClient(redirectUri: string) {
  const fallbackClientId = getClientId();

  const response = await fetch(`${getApiBaseUrl()}/api/auth/oauth2/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "VelaMind Extension",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: DEFAULT_SCOPE,
    }),
  });

  const payload = (await response.json().catch(() => null)) as {
    client_id?: string;
  } | null;

  if (!response.ok || !payload?.client_id) {
    return fallbackClientId;
  }

  return payload.client_id;
}

async function signInWithPkce() {
  const redirectUri = chrome.identity.getRedirectURL("provider_cb");
  const clientId = await registerPublicClient(redirectUri);
  const verifier = randomString(32);
  const challenge = await pkceChallenge(verifier);
  const state = randomString(16);

  const authorizeUrl = new URL(`${getApiBaseUrl()}/api/auth/oauth2/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", DEFAULT_SCOPE);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  });

  if (!redirect) {
    throw new Error("No redirect URL returned from auth flow");
  }

  const callbackUrl = new URL(redirect);
  const returnedState = callbackUrl.searchParams.get("state");
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch");
  }

  const code = callbackUrl.searchParams.get("code");
  if (!code) {
    const error = callbackUrl.searchParams.get("error");
    const description = callbackUrl.searchParams.get("error_description");
    throw new Error(description || error || "Authorization code is missing");
  }

  const tokens = await exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  );

  const stored: AuthTokens = {
    ...tokens,
    clientId,
  };
  await writeTokens(stored);
  return stored;
}

async function refreshTokens() {
  const existing = await readTokens();
  if (!existing?.refreshToken) {
    throw new Error("No refresh token available");
  }

  const refreshed = await exchangeToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: existing.refreshToken,
      client_id: existing.clientId,
    }),
  );

  const merged: AuthTokens = {
    ...existing,
    ...refreshed,
    refreshToken: refreshed.refreshToken || existing.refreshToken,
  };

  await writeTokens(merged);
  return merged;
}

async function ensureAccessToken() {
  const existing = await readTokens();
  if (!existing) {
    return null;
  }

  if (!tokenIsExpired(existing)) {
    return existing;
  }

  try {
    return await refreshTokens();
  } catch {
    await writeTokens(null);
    return null;
  }
}

async function fetchUserInfo() {
  const tokens = await ensureAccessToken();
  if (!tokens) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${getApiBaseUrl()}/api/auth/oauth2/userinfo`, {
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
    },
  });

  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    throw new Error(
      (payload?.error_description as string) || "Failed to fetch user info",
    );
  }

  return payload;
}

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function fail(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  };
}

export default defineBackground({
  main() {
    chrome.runtime.onMessage.addListener(
      (
        message: unknown,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => {
        const command =
          message && typeof message === "object" && "command" in message
            ? ((message as { command?: unknown }).command as string | undefined)
            : undefined;

        if (!command) {
          sendResponse(fail("Missing command"));
          return false;
        }

        void (async () => {
          try {
            if (command === "auth.sign-in") {
              sendResponse(ok(await signInWithPkce()));
              return;
            }

            if (command === "auth.refresh") {
              sendResponse(ok(await refreshTokens()));
              return;
            }

            if (command === "auth.session") {
              const tokens = await ensureAccessToken();
              sendResponse(
                ok({
                  authenticated: Boolean(tokens),
                  tokens,
                }),
              );
              return;
            }

            if (command === "auth.userinfo") {
              sendResponse(ok(await fetchUserInfo()));
              return;
            }

            if (command === "auth.sign-out") {
              await writeTokens(null);
              sendResponse(ok({ signedOut: true }));
              return;
            }

            sendResponse(fail(`Unknown command: ${command}`));
          } catch (error) {
            sendResponse(fail(error));
          }
        })();

        return true;
      },
    );

    void ensureAccessToken();
    // eslint-disable-next-line no-console
    console.log("[extension] background started");
  },
});
