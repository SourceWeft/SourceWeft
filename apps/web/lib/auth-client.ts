"use client";

import { createAuthClient } from "better-auth/react";
import {
  emailOTPClient,
  magicLinkClient,
  multiSessionClient,
  oneTapClient,
  organizationClient,
  twoFactorClient,
  usernameClient,
} from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";

function resolveAuthBaseUrl() {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
  return `${base.replace(/\/$/, "")}/api/auth`;
}

const oneTapClientId =
  process.env.NEXT_PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID?.trim() || "";

export const authClient = createAuthClient({
  baseURL: resolveAuthBaseUrl(),
  fetchOptions: {
    credentials: "include",
  },
  plugins: [
    organizationClient(),
    usernameClient(),
    multiSessionClient(),
    twoFactorClient(),
    apiKeyClient(),
    emailOTPClient(),
    magicLinkClient(),
    passkeyClient(),
    oauthProviderClient(),
    ...(oneTapClientId
      ? [
          oneTapClient({
            clientId: oneTapClientId,
            promptOptions: {
              baseDelay: 1000,
              maxAttempts: 3,
            },
          }),
        ]
      : []),
  ],
});
