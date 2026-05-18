"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  publishConnectorOAuthCompletion,
  type ConnectorOAuthCompletionMessage,
} from "../_components/oauth-messaging";

type OAuthCompleteState = "success" | "error";

function createMessage(input: {
  accountId: string | null;
  connectorOAuth: string | null;
  connectorType: string | null;
  error: string | null;
  workspaceId: string | null;
}): ConnectorOAuthCompletionMessage {
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
    error:
      status === "error"
        ? input.error ?? "Connector authorization did not complete."
        : null,
    createdAt: new Date().toISOString(),
  };
}

export function ConnectorOAuthCompleteClient({
  accountId,
  connectorOAuth,
  connectorType,
  error,
  returnTo,
  workspaceId,
}: {
  accountId: string | null;
  connectorOAuth: string | null;
  connectorType: string | null;
  error: string | null;
  returnTo: string | null;
  workspaceId: string | null;
}) {
  const [closeAttempted, setCloseAttempted] = useState(false);
  const message = useMemo(
    () =>
      createMessage({
        accountId,
        connectorOAuth,
        connectorType,
        error,
        workspaceId,
      }),
    [accountId, connectorOAuth, connectorType, error, workspaceId],
  );
  const isSuccess = message.status === "success";

  useEffect(() => {
    publishConnectorOAuthCompletion(message);
    const timer = window.setTimeout(() => {
      setCloseAttempted(true);
      window.close();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [message]);

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
              {isSuccess ? "Connector authorized" : "Authorization failed"}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {isSuccess
                ? "SourceWeft is updating the connector status in the original tab."
                : message.error}
            </p>
          </div>
        </div>
        {closeAttempted ? (
          <div className="mt-4 flex gap-2">
            {returnTo ? (
              <Button asChild className="flex-1" type="button">
                <a href={returnTo}>Return to SourceWeft</a>
              </Button>
            ) : null}
            <Button
              className="flex-1"
              onClick={() => window.close()}
              type="button"
              variant={returnTo ? "outline" : "default"}
            >
              Close tab
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
