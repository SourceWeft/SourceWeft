"use client";

import { DeploymentCapabilitiesProvider } from "../lib/billing-edition/capabilities";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@sourceweft/ui-web/components/ui/tooltip";
import Link from "next/link";
import { ThemeProvider, useTheme } from "next-themes";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Toaster } from "sonner";
import { DEFAULT_USER_THEME } from "@sourceweft/contracts";
import { AuthProvider } from "./_components/auth/auth-provider";
import { GoogleOneTap } from "./google-one-tap";
import { MobileRouteSheetProvider } from "./mobile-route-sheet-provider";
import { authClient } from "../lib/auth-client";
import {
  additionalFields,
  organizationPluginOptions,
} from "../lib/auth-ui-config";
import { apiKeyPlugin } from "../lib/auth/api-key-plugin";
import { emailOtpPlugin } from "../lib/auth/email-otp-plugin";
import { magicLinkPlugin } from "../lib/auth/magic-link-plugin";
import { multiSessionPlugin } from "../lib/auth/multi-session-plugin";
import { organizationPlugin } from "../lib/auth/organization-plugin";
import { passkeyPlugin } from "../lib/auth/passkey-plugin";
import { twoFactorPlugin } from "../lib/auth/two-factor-plugin";
import { getQueryClient } from "../lib/query-client";
import { userSettingsClient } from "../lib/sdk";
import {
  clearLocaleCookie,
  getLocaleCookie,
  setLocaleCookie,
} from "../lib/i18n/cookie";
import { desktopBridge } from "../lib/desktop-bridge";

import { publicWebBaseUrl as resolveWebBaseUrl } from "../lib/public-runtime-config";

function shouldIgnoreCancelledPasskey(message?: string) {
  if (!message) {
    return false;
  }

  return /(auth_cancelled|registration_cancelled|ceremony_aborted|notallowederror|cancelled|canceled)/i.test(
    message,
  );
}

function isCancelledPasskeyRejection(reason: unknown) {
  if (reason instanceof DOMException && reason.name === "NotAllowedError") {
    return true;
  }

  if (reason instanceof Error) {
    return shouldIgnoreCancelledPasskey(reason.message);
  }

  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") {
      return shouldIgnoreCancelledPasskey(message);
    }
  }

  return false;
}

export function UserSettingsSync() {
  const { data: session } = authClient.useSession();
  const { setTheme } = useTheme();
  const router = useRouter();
  const locale = useLocale();
  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) {
      return;
    }

    let cancelled = false;
    void userSettingsClient
      .getSettings()
      .then((result) => {
        if (cancelled) {
          return;
        }
        const { theme, language } = result.settings.appearance;
        setTheme(theme);
        // Mirror the saved language into the cookie the proxy reads, so a signed-in
        // user's choice follows them across devices (§5). The account setting is the
        // one long-term truth — "system" means "follow the browser", so we clear the
        // explicit cookie rather than pin one.
        //
        // A brand-new browser/device has no `sw_locale` cookie yet, so the very first
        // SSR render used Accept-Language, not the account setting — on sign-in there,
        // this can genuinely disagree with what the account says. Refresh only when
        // what's already rendered (`locale`) would actually change, so a returning
        // visitor (the common case, cookie already agrees) never sees a needless
        // extra fetch on every mount.
        const pinnedCookie = getLocaleCookie();
        if (language === "system") {
          clearLocaleCookie();
          if (pinnedCookie) {
            router.refresh();
          }
        } else {
          setLocaleCookie(language);
          if (locale !== language) {
            router.refresh();
          }
        }
      })
      .catch(() => {
        // Keep next-themes local cache and the existing cookie as the fallback.
      });

    return () => {
      cancelled = true;
    };
  }, [setTheme, userId, router, locale]);

  return null;
}

function DesktopTraySync() {
  // `useLocale()` is the fully-resolved locale the page is actually
  // rendering right now — already through the whole priority chain (user
  // setting → cookie → Accept-Language → default). The Tauri shell's Rust
  // side has no visibility into that resolution (no cookie jar access, no
  // React state), so it relies on this component telling it the answer
  // whenever it changes, including a live in-app language switch — not just
  // on mount (see `apps/desktop/src-tauri/src/tray_locale.rs`).
  const locale = useLocale();

  useEffect(() => {
    if (!desktopBridge.isAvailable()) {
      return;
    }
    void desktopBridge.syncTrayLocale(locale).catch(() => {
      // Best-effort: the tray keeps its last-known (or OS-guessed) label.
    });
  }, [locale]);

  return null;
}

/**
 * Re-renders server components when the signed-in user changes.
 *
 * The old auth UI package offered an `onSessionChange` callback for this; the
 * successor has no equivalent, so watch the session directly. `/dashboard` is
 * excluded because it holds client state a refresh would discard.
 */
function SessionRefreshSync() {
  const { data: session } = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const userId = session?.user?.id ?? null;
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const previous = previousUserId.current;
    previousUserId.current = userId;

    // Skip the first observed value: nothing changed, we just learned it.
    if (previous === undefined || previous === userId) {
      return;
    }

    const normalizedPathname = pathname?.replace(/\/+$/, "") || "/";
    if (
      normalizedPathname === "/dashboard" ||
      normalizedPathname.startsWith("/dashboard/")
    ) {
      return;
    }

    router.refresh();
  }, [pathname, router, userId]);

  return null;
}

export function Providers({
  children,
  initialCapabilities = null,
}: {
  children: React.ReactNode;
  initialCapabilities?: DeploymentCapabilities | null;
}) {
  const router = useRouter();
  const webBaseUrl = resolveWebBaseUrl();
  const queryClient = getQueryClient();

  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      if (isCancelledPasskeyRejection(event.reason)) {
        event.preventDefault();
      }
    };

    window.addEventListener("unhandledrejection", handler);
    return () => {
      window.removeEventListener("unhandledrejection", handler);
    };
  }, []);

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={DEFAULT_USER_THEME}
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          additionalFields={additionalFields}
          authClient={authClient}
          baseURL={webBaseUrl}
          emailAndPassword={{
            forgotPassword: true,
            // Mirrors apps/backend's auth config: the views read this to send
            // someone to verify-email after sign-up instead of the dashboard.
            requireEmailVerification: true,
          }}
          Link={Link}
          navigate={({ to, replace }) =>
            replace ? router.replace(to) : router.push(to)
          }
          plugins={[
            magicLinkPlugin(),
            emailOtpPlugin({ signIn: true }),
            passkeyPlugin(),
            twoFactorPlugin({ enrollmentMethods: ["otp", "totp"] }),
            multiSessionPlugin(),
            apiKeyPlugin({ organization: true }),
            organizationPlugin(organizationPluginOptions),
          ]}
          redirectTo="/dashboard"
          socialProviders={["google", "github"]}
        >
          {/* Supersedes the theme-only ThemeSettingsSync: also mirrors
              appearance.language into the locale cookie (cross-device
              follow, §5) and self-corrects a fresh device's first render.
              TODO(i18n): @better-auth-ui/locales ships no zh-CN/zh-TW
              bundle; the existing translated `authUi` catalog entries need
              re-keying onto this provider's `localization`/`defineAuthLocale`
              shape in a follow-up, once the package is installed and its
              real types can be checked instead of guessed. */}
          <UserSettingsSync />
          <DesktopTraySync />
          <SessionRefreshSync />
          <GoogleOneTap />
          <TooltipProvider>
            <DeploymentCapabilitiesProvider
              initialCapabilities={initialCapabilities}
            >
              <MobileRouteSheetProvider>{children}</MobileRouteSheetProvider>
            </DeploymentCapabilitiesProvider>
          </TooltipProvider>
          <Toaster closeButton position="top-right" richColors />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
