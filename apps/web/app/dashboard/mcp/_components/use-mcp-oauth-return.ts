"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { contentClient } from "../../../../lib/sdk";

/**
 * Handles the browser coming back from an MCP provider's sign-in. The callback
 * only says what happened through query parameters, which anyone can type, so
 * a success is accepted only after the API confirms its completion reference
 * for the signed-in member; the parameters are then stripped, so a refresh
 * does not repeat anything. `onConnected` gets the confirmed install.
 */
export function useMcpOAuthReturn(input: {
  workspaceId: string | null;
  onConnected: (completion: { workspaceId: string; installId: string }) => void;
}) {
  const t = useTranslations("dashboardMcpPanel");
  const router = useRouter();
  const searchParams = useSearchParams();
  const handledRef = React.useRef<string | null>(null);
  const { workspaceId, onConnected } = input;

  React.useEffect(() => {
    const status = searchParams.get("mcpOAuth");
    if (!status) return;
    // Wait for the workspace to resolve: handling earlier would drop the
    // cache invalidation for good.
    if (!workspaceId) return;
    const marker = `${status}:${searchParams.get("mcpRef") ?? ""}`;
    if (handledRef.current === marker) return;
    handledRef.current = marker;

    const ref = searchParams.get("mcpRef");
    const reason = searchParams.get("mcpReason");
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["mcpOAuth", "mcpRef", "mcpReason"]) params.delete(key);
    // The browser's own (still-encoded) path: a market identifier in it has
    // its `/` as %2F, which a decoded pathname would turn into a new segment.
    router.replace(
      `${window.location.pathname}${params.size ? `?${params}` : ""}`,
    );

    if (status === "connected" && !ref) {
      toast.error(t("toasts.connectUnconfirmed"));
    } else if (status === "connected" && ref) {
      contentClient
        .getWorkspaceMcpOAuthCompletion(ref)
        .then((completion) => {
          if (completion.workspaceId !== workspaceId) {
            toast.error(t("toasts.connectUnconfirmed"));
            return;
          }
          onConnected(completion);
        })
        .catch(() => toast.error(t("toasts.connectUnconfirmed")));
    } else if (status === "invalid") {
      toast.error(t("toasts.authInvalid"));
    } else if (status === "error" && reason === "denied") {
      toast.error(t("toasts.authDenied"));
    } else if (status === "error" && reason === "timeout") {
      toast.error(t("toasts.authTimeout"));
    } else {
      toast.error(t("toasts.authFailed"));
    }
  }, [onConnected, router, searchParams, t, workspaceId]);
}
