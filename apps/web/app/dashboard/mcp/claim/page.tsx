"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { McpClaimOverview } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";

import { getMcpClaimOverview } from "../../../../lib/mcp-claims";
import { McpClaimFlow } from "./_components/mcp-claim-flow";
import { McpClaimList } from "./_components/mcp-claim-list";
import { McpOwnerPanel } from "./_components/mcp-owner-panel";
import {
  claimPageView,
  normalizeClaimIdentifier,
} from "./_components/mcp-claim-view";

type LoadFailure = "signedOut" | "notFound" | "loadFailed";

function loadFailureOf(error: unknown): LoadFailure {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (status === 401) return "signedOut";
  if (status === 404 || code === "MCP_CLAIM_ENTRY_NOT_FOUND") return "notFound";
  return "loadFailed";
}

/**
 * `/dashboard/mcp/claim?identifier=com.example/server` — where a catalog MCP
 * server's publisher claims it (Issue #367, W7) and, once verified, manages
 * its listing. The public server page links here.
 */
function ClaimPage() {
  const t = useTranslations("dashboardMcpClaim.page");
  const identifier = normalizeClaimIdentifier(
    useSearchParams().get("identifier"),
  );

  const [overview, setOverview] = React.useState<McpClaimOverview | null>(
    null,
  );
  const [loading, setLoading] = React.useState(Boolean(identifier));
  const [failure, setFailure] = React.useState<LoadFailure | null>(null);
  const generationRef = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!identifier) return;
    const generation = ++generationRef.current;
    setFailure(null);
    try {
      const result = await getMcpClaimOverview(identifier);
      if (generationRef.current === generation) setOverview(result);
    } catch (error) {
      if (generationRef.current === generation) {
        setOverview(null);
        setFailure(loadFailureOf(error));
      }
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, [identifier]);

  React.useEffect(() => {
    setOverview(null);
    setLoading(Boolean(identifier));
    void load();
  }, [identifier, load]);

  const view = overview ? claimPageView(overview) : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Button
            asChild
            aria-label={t("back")}
            className="h-8 w-8 rounded-full p-0"
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Link href="/dashboard/mcp">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-base font-semibold text-foreground">
            {t("title")}
          </h1>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
            <section className="rounded-2xl border border-border bg-background p-5 shadow-xs">
              <p className="text-sm text-foreground">{t("intro")}</p>
              {overview ? (
                <div className="mt-4">
                  <h2 className="text-lg font-semibold text-foreground">
                    {overview.name}
                  </h2>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {overview.identifier}
                  </p>
                </div>
              ) : identifier ? (
                <p className="mt-4 truncate font-mono text-xs text-muted-foreground">
                  {identifier}
                </p>
              ) : null}
            </section>

            {!identifier ? (
              <p className="text-sm text-muted-foreground">
                {t("missingIdentifier")}
              </p>
            ) : loading ? (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              </div>
            ) : failure ? (
              <div className="space-y-3 text-sm" role="alert">
                <p
                  className={
                    failure === "loadFailed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {t(failure)}
                </p>
                {failure === "loadFailed" ? (
                  <Button onClick={() => void load()} size="sm" variant="outline">
                    {t("retry")}
                  </Button>
                ) : null}
              </div>
            ) : overview && view ? (
              view.kind === "owner" ? (
                <McpOwnerPanel onChanged={load} overview={overview} />
              ) : view.kind === "claimedBySomeone" ? (
                <>
                  <p className="rounded-2xl border border-border bg-background p-5 text-sm text-muted-foreground">
                    {t("claimedBySomeone")}
                  </p>
                  {overview.viewerClaims.length > 0 ? (
                    <McpClaimList
                      busy
                      claims={overview.viewerClaims}
                      onVerify={() => {}}
                    />
                  ) : null}
                </>
              ) : (
                <McpClaimFlow onChanged={load} overview={overview} />
              )
            ) : null}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}

export default function McpClaimPage() {
  // `useSearchParams` needs a boundary when the route is prerendered.
  return (
    <React.Suspense fallback={null}>
      <ClaimPage />
    </React.Suspense>
  );
}
