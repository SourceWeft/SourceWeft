"use client";

import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import { TooltipProvider } from "@sourceweft/ui-web/components/ui/tooltip";
import type { SocialProvider } from "better-auth/social-providers";
import Link from "next/link";
import { ThemeProvider, useTheme } from "next-themes";
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
import { registerBuiltinAgentTools } from "../lib/register-builtin-agent-tools";
import { userSettingsClient } from "../lib/sdk";

registerBuiltinAgentTools();

function resolveWebBaseUrl() {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_WEB_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  if (typeof window !== "undefined" && window.location.origin) {
    return window.location.origin;
  }

  return "http://localhost:3000";
}

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

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const webBaseUrl = resolveWebBaseUrl();

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
        <ThemeSettingsSync />
        <GoogleOneTap />
        <TooltipProvider>
          <MobileRouteSheetProvider>{children}</MobileRouteSheetProvider>
        </TooltipProvider>
        <Toaster closeButton position="top-right" richColors />
      </AuthUIProvider>
    </ThemeProvider>
  );
}
