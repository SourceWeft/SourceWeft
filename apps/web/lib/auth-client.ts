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
import { billingAuthClientPlugins } from "./billing-edition/auth-client";
import { apiBaseUrl } from "./api-base-url";
import { resolveGoogleOneTapConfig } from "./google-one-tap-config";

function resolveAuthBaseUrl() {
  return `${apiBaseUrl}/api/auth`;
}

const googleOneTapConfig = resolveGoogleOneTapConfig();

// Locales the app exposes; must match the backend i18n plugin (design §16).
const SW_LOCALES = new Set(["en", "zh-CN", "zh-TW"]);

// The active locale lives in the non-HttpOnly `sw_locale` cookie (written by
// the language switcher). Reading it at request time lets the backend
// `@better-auth/i18n` plugin return localized error messages even when auth
// calls are cross-origin and the cookie itself is not forwarded — the value is
// echoed in the `x-sw-locale` header the plugin's callback strategy reads.
function readActiveLocale(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const match = document.cookie.match(/(?:^|;\s*)sw_locale=([^;]+)/);
  if (!match?.[1]) {
    return null;
  }
  const value = decodeURIComponent(match[1]);
  return SW_LOCALES.has(value) ? value : null;
}

export const authClient = createAuthClient({
  baseURL: resolveAuthBaseUrl(),
  fetchOptions: {
    credentials: "include",
    onRequest: (context) => {
      const locale = readActiveLocale();
      if (locale) {
        context.headers.set("x-sw-locale", locale);
      }
    },
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
    ...billingAuthClientPlugins,
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
