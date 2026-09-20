"use client";

import { DeploymentCapabilitiesProvider } from "../lib/billing-edition/capabilities";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";
import { AuthUIProvider, type AuthLocalization } from "@daveyplate/better-auth-ui";
import { TooltipProvider } from "@sourceweft/ui-web/components/ui/tooltip";
import type { SocialProvider } from "better-auth/social-providers";
import Link from "next/link";
import { ThemeProvider, useTheme } from "next-themes";
import { useMessages } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { Toaster, toast as sonnerToast } from "sonner";
import { DEFAULT_USER_THEME } from "@sourceweft/contracts";
import { GoogleOneTap } from "./google-one-tap";
import { MobileRouteSheetProvider } from "./mobile-route-sheet-provider";
import { authClient } from "../lib/auth-client";
import {
  additionalFields,
  customAccountViewPaths,
  customAuthViewPaths,
  customOrganizationViewPaths,
} from "../lib/auth-ui-config";
import { userSettingsClient } from "../lib/sdk";
import { clearLocaleCookie, setLocaleCookie } from "../lib/i18n/cookie";

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

function UserSettingsSync() {
  const { data: session } = authClient.useSession();
  const { setTheme } = useTheme();
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
        // user's choice follows them across devices (§5). "system" means "follow the
        // browser", so we clear the explicit cookie. The switcher (Phase 1A) adds the
        // in-place refresh; here the new locale takes effect on the next navigation.
        if (language === "system") {
          clearLocaleCookie();
        } else {
          setLocaleCookie(language);
        }
      })
      .catch(() => {
        // Keep next-themes local cache and the existing cookie as the fallback.
      });

    return () => {
      cancelled = true;
    };
  }, [setTheme, userId]);

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
  const pathname = usePathname();
  const webBaseUrl = resolveWebBaseUrl();
  // Resolve the current locale's Better Auth UI labels from the next-intl catalog.
  // The provider deep-merges this partial over its English defaults, so any key we
  // don't ship (or the `en` locale) falls back to English automatically. Error
  // messages stay on the backend path — see `localizeErrors={false}` below.
  const messages = useMessages();
  const authUiLocalization = messages.authUi as unknown as AuthLocalization;

  const handleSessionChange = useCallback(() => {
    const normalizedPathname = pathname?.replace(/\/+$/, "") || "/";
    if (
      normalizedPathname === "/dashboard" ||
      normalizedPathname.startsWith("/dashboard/")
    ) {
      return;
    }

    router.refresh();
  }, [pathname, router]);

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
      <AuthUIProvider
        Link={Link}
        baseURL={webBaseUrl}
        account={{
          basePath: "/account",
          fields: ["image", "name", "company", "role", "timezone", "bio"],
          viewPaths: customAccountViewPaths,
        }}
        additionalFields={additionalFields}
        apiKey={{
          prefix: "vm_",
        }}
        authClient={authClient}
        credentials={{
          forgotPassword: true,
        }}
        localization={authUiLocalization}
        localizeErrors={false}
        magicLink
        multiSession
        navigate={router.push}
        onSessionChange={handleSessionChange}
        organization={{
          apiKey: true,
          basePath: "/organization",
          viewPaths: customOrganizationViewPaths,
        }}
        passkey
        replace={router.replace}
        redirectTo="/dashboard"
        signUp={{
          fields: ["name"],
        }}
        social={{
          providers: ["google", "github"] satisfies SocialProvider[],
        }}
        toast={({ message, variant }) => {
          if (variant === "error" && shouldIgnoreCancelledPasskey(message)) {
            return;
          }

          const text = message || "Operation completed";
          if (variant === "error") {
            sonnerToast.error(text);
            return;
          }

          if (variant === "warning") {
            sonnerToast.warning(text);
            return;
          }

          if (variant === "success") {
            sonnerToast.success(text);
            return;
          }

          sonnerToast(text);
        }}
        twoFactor={["otp", "totp"]}
        viewPaths={customAuthViewPaths}
      >
        <UserSettingsSync />
        <GoogleOneTap />
        <TooltipProvider>
          <DeploymentCapabilitiesProvider
            initialCapabilities={initialCapabilities}
          >
            <MobileRouteSheetProvider>{children}</MobileRouteSheetProvider>
          </DeploymentCapabilitiesProvider>
        </TooltipProvider>
        <Toaster closeButton position="top-right" richColors />
      </AuthUIProvider>
    </ThemeProvider>
  );
}
