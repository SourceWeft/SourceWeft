"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { connectorsClient } from "../../../../../lib/sdk";

type OAuthStartState =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string };

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

function buildCompletionUrl(input: {
  workspaceId: string;
  connectorType: string;
  returnTo: string | null;
}) {
  const url = new URL("/dashboard/connectors/oauth/complete", window.location.origin);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("connector_type", input.connectorType);
  if (input.returnTo) {
    url.searchParams.set("return_to", input.returnTo);
  }
  return url.toString();
}

export function ConnectorOAuthStartClient({
  connectorType,
  returnTo,
  workspaceId,
}: {
  connectorType: string | null;
  returnTo: string | null;
  workspaceId: string | null;
}) {
  const [state, setState] = useState<OAuthStartState>({
    kind: "loading",
    message: "Starting connector authorization...",
  });

  useEffect(() => {
    let cancelled = false;

    async function startOAuth() {
      if (!workspaceId || !connectorType) {
        setState({
          kind: "error",
          message: "This connector authorization link is missing required context.",
        });
        return;
      }

      try {
        const result = await connectorsClient.startOAuth(
          workspaceId,
          connectorType,
          {
            redirectAfter: buildCompletionUrl({
              workspaceId,
              connectorType,
              returnTo,
            }),
          },
        );
        if (!cancelled) {
          window.location.replace(result.authorizationUrl);
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: getErrorMessage(
              error,
              "Failed to start connector authorization.",
            ),
          });
        }
      }
    }

    void startOAuth();

    return () => {
      cancelled = true;
    };
  }, [connectorType, returnTo, workspaceId]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          {state.kind === "loading" ? (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
          <div className="min-w-0">
            <h1 className="text-base font-semibold">
              {state.kind === "loading"
                ? "Opening authorization"
                : "Authorization could not start"}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {state.message}
            </p>
          </div>
        </div>
        {state.kind === "error" ? (
          <Button
            className="mt-4 w-full"
            onClick={() => window.close()}
            type="button"
            variant="outline"
          >
            Close tab
          </Button>
        ) : null}
      </section>
    </main>
  );
}
