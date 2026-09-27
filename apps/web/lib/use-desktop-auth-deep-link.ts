"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { handleDesktopAuthDeepLink } from "./desktop-auth";
import { desktopBridge } from "./desktop-bridge";

/**
 * Finishes desktop sign-in when the browser hands back its deep link, then
 * opens `destination`. Every page the desktop window may be showing when the
 * link arrives mounts this, so a late link is still picked up.
 */
export function useDesktopAuthDeepLink(destination: string) {
  const router = useRouter();
  const t = useTranslations("authPages.desktopLogin");

  useEffect(() => {
    if (!desktopBridge.isAvailable()) {
      return;
    }

    const cleanupTask = desktopBridge.onDeepLink((payload) => {
      const url = payload.url.trim();
      if (!url) {
        return;
      }

      void handleDesktopAuthDeepLink({
        url,
        onSuccess: () => {
          router.replace(destination);
          router.refresh();
        },
        onError: (error) =>
          toast.error(
            error === "missing-token"
              ? t("deepLinkMissingToken")
              : t("signInFailed"),
          ),
      });
    });

    return () => {
      cleanupTask.then((cleanup) => void cleanup()).catch(() => {});
    };
  }, [destination, router, t]);
}
