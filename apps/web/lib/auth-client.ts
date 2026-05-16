"use client";

import { createAuthClient } from "better-auth/react";
import {
  emailOTPClient,
  magicLinkClient,
  multiSessionClient,
  oneTimeTokenClient,
  oneTapClient,
  organizationClient,
  twoFactorClient,
  usernameClient,
} from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { creemClient } from "@creem_io/better-auth/client";
import { apiBaseUrl } from "./api-base-url";
import { resolveGoogleOneTapConfig } from "./google-one-tap-config";

function resolveAuthBaseUrl() {
  return `${apiBaseUrl}/api/auth`;
}

const googleOneTapConfig = resolveGoogleOneTapConfig();

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
    oneTimeTokenClient(),
    passkeyClient(),
    oauthProviderClient(),
    creemClient(),
    ...(googleOneTapConfig.active
      ? [
          oneTapClient({
            clientId: googleOneTapConfig.clientId,
            ...(googleOneTapConfig.fedCmEnabled
              ? {
                  additionalOptions: {
                    use_fedcm_for_prompt: true,
                  },
                }
              : {}),
            promptOptions: {
              baseDelay: 1000,
              maxAttempts: 3,
            },
          }),
        ]
      : []),
  ],
});
