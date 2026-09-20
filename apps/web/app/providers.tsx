"use client";

import { DeploymentCapabilitiesProvider } from "../lib/billing-edition/capabilities";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@sourceweft/ui-web/components/ui/tooltip";
import Link from "next/link";
import { ThemeProvider, useTheme } from "next-themes";
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

function ThemeSettingsSync() {
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
        if (!cancelled) {
          setTheme(result.settings.appearance.theme);
        }
      })
      .catch(() => {
        // Keep next-themes local cache as the first-paint fallback.
      });

    return () => {
      cancelled = true;
    };
  }, [setTheme, userId]);

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
  requireEmailVerification = true,
}: {
  children: React.ReactNode;
  initialCapabilities?: DeploymentCapabilities | null;
  /** The API's answer (see `resolveRequireEmailVerification`). */
  requireEmailVerification?: boolean;
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
            // Mirrors apps/backend's auth config, which requires it only
            // where mail can be delivered: the views read this to send someone
            // to verify-email after sign-up instead of the dashboard.
            requireEmailVerification,
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
          <ThemeSettingsSync />
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
