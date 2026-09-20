"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  publishConnectorOAuthCompletion,
  type ConnectorOAuthCompletionMessage,
} from "../_components/oauth-messaging";

type OAuthCompleteState = "success" | "error";

function safeReturnUrl(value: string | null) {
  if (!value) {
    return new URL("/dashboard/chat", window.location.origin);
  }

  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) {
      return new URL("/dashboard/chat", window.location.origin);
    }
    return url;
  } catch {
    return new URL("/dashboard/chat", window.location.origin);
  }
}

function createMessage(
  input: {
    accountId: string | null;
    connectorOAuth: string | null;
    connectorType: string | null;
    error: string | null;
    workspaceId: string | null;
  },
  fallbackError: string,
): ConnectorOAuthCompletionMessage {
  const status: OAuthCompleteState =
    input.connectorOAuth === "success" && input.accountId ? "success" : "error";
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId: input.workspaceId ?? "",
    connectorType: input.connectorType ?? "",
    accountId: input.accountId,
    status,
    error: status === "error" ? input.error ?? fallbackError : null,
    createdAt: new Date().toISOString(),
  };
}

export function ConnectorOAuthCompleteClient({
  accountId,
  connectorOAuth,
  connectorType,
  error,
  mode,
  returnTo,
  workspaceId,
}: {
  accountId: string | null;
  connectorOAuth: string | null;
  connectorType: string | null;
  error: string | null;
  mode: string | null;
  returnTo: string | null;
  workspaceId: string | null;
}) {
  const t = useTranslations("dashboardConnectors");
  const [closeAttempted, setCloseAttempted] = useState(false);
  const message = useMemo(
    () =>
      createMessage(
        {
          accountId,
          connectorOAuth,
          connectorType,
          error,
          workspaceId,
        },
        t("complete.fallbackError"),
      ),
    [accountId, connectorOAuth, connectorType, error, workspaceId, t],
  );
  const isSuccess = message.status === "success";

  useEffect(() => {
    if (mode === "redirect") {
      const returnUrl = safeReturnUrl(returnTo);
      returnUrl.searchParams.set("connector_oauth", message.status);
      returnUrl.searchParams.set("connector_type", message.connectorType);
      returnUrl.searchParams.set("workspace_id", message.workspaceId);
      if (message.accountId) {
        returnUrl.searchParams.set("account_id", message.accountId);
      } else {
        returnUrl.searchParams.delete("account_id");
      }
      if (message.error) {
        returnUrl.searchParams.set("error", message.error);
      } else {
        returnUrl.searchParams.delete("error");
      }
      window.location.replace(returnUrl.toString());
      return;
    }

    publishConnectorOAuthCompletion(message);
    const timer = window.setTimeout(() => {
      setCloseAttempted(true);
      window.close();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [message, mode, returnTo]);

  const Icon = isSuccess ? CheckCircle2 : CircleAlert;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <Icon
            className={
              isSuccess
                ? "mt-0.5 size-5 shrink-0 text-emerald-600"
                : "mt-0.5 size-5 shrink-0 text-destructive"
            }
          />
          <div className="min-w-0">
            <h1 className="text-base font-semibold">
              {isSuccess
                ? t("complete.successTitle")
                : t("complete.errorTitle")}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {mode === "redirect"
                ? isSuccess
                  ? t("complete.redirectSuccess")
                  : t("complete.redirectError")
                : isSuccess
                  ? t("complete.popupSuccess")
                  : message.error}
            </p>
          </div>
        </div>
        {mode !== "redirect" && closeAttempted ? (
          <div className="mt-4 flex gap-2">
            {returnTo ? (
              <Button asChild className="flex-1" type="button">
                <a href={returnTo}>{t("common.returnToSourceweft")}</a>
              </Button>
            ) : null}
            <Button
              className="flex-1"
              onClick={() => window.close()}
              type="button"
              variant={returnTo ? "outline" : "default"}
            >
              {t("common.closeTab")}
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
