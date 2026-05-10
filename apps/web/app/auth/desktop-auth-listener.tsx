"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  desktopBridge,
  handleDesktopAuthDeepLink,
} from "../../lib/desktop-bridge";

export function DesktopAuthListener() {
  const router = useRouter();

  useEffect(() => {
    if (!desktopBridge.isAvailable()) {
      return;
    }

    const cleanupTask = desktopBridge.onDeepLink((payload) => {
      void handleDesktopAuthDeepLink({
        url: payload.url,
        onSuccess: () => {
          router.replace("/dashboard");
          router.refresh();
        },
        onError: (message) => toast.error(message),
      });
    });

    return () => {
      cleanupTask
        .then((cleanup) => void cleanup())
        .catch(() => {});
    };
  }, [router]);

  return null;
}
