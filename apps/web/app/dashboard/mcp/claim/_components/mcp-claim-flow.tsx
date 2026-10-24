"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type {
  McpClaim,
  McpClaimInstructions,
  McpClaimMethod,
  McpClaimOverview,
} from "@sourceweft/contracts";

import { authClient } from "../../../../../lib/auth-client";
import {
  mcpClaimErrorMessage,
  startMcpClaim,
  verifyMcpClaim,
} from "../../../../../lib/mcp-claims";
import { McpClaimInstructionsCard } from "./mcp-claim-instructions";
import { McpClaimList } from "./mcp-claim-list";
import { McpClaimMethods } from "./mcp-claim-methods";

/**
 * Claiming an unclaimed server: the method chooser, the one-time publishing
 * instructions of a domain claim just started, and the viewer's claims with
 * their Verify buttons. `onChanged` reloads the overview after each request.
 * A viewer an admin blocked on this server gets a notice card instead.
 */
export function McpClaimFlow({
  onChanged,
  overview,
}: {
  onChanged: () => void | Promise<void>;
  overview: McpClaimOverview;
}) {
  const t = useTranslations("dashboardMcpClaim");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [started, setStarted] = React.useState<{
    claim: McpClaim;
    instructions: McpClaimInstructions;
  } | null>(null);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      await action();
    } catch (caught) {
      setError(mcpClaimErrorMessage(caught, t));
      const code = (caught as { code?: unknown } | null)?.code;
      setErrorCode(typeof code === "string" ? code : null);
    } finally {
      await onChanged();
      setBusy(false);
    }
  }

  function claimGithub() {
    void act(async () => {
      await startMcpClaim(overview.identifier, { method: "github" });
      toast.success(t("page.toasts.verified"));
    });
  }

  function startDomain(method: Extract<McpClaimMethod, "dns_txt" | "well_known">) {
    void act(async () => {
      const result = await startMcpClaim(overview.identifier, { method });
      if (result.instructions) {
        setStarted({ claim: result.claim, instructions: result.instructions });
      }
      toast.success(t("page.toasts.started"));
    });
  }

  function verify(claimId: string) {
    void act(async () => {
      const { claim } = await verifyMcpClaim(claimId);
      if (claim.status === "verified") {
        setStarted(null);
        toast.success(t("page.toasts.verified"));
      } else {
        toast.message(t("page.toasts.stillPending"));
      }
    });
  }

  // Better Auth sends the browser to GitHub and back to this page.
  function linkGithub(scopes?: string[]) {
    void authClient.linkSocial({
      provider: "github",
      callbackURL: window.location.href,
      ...(scopes ? { scopes } : {}),
    });
  }

  if (overview.blocked) {
    return (
      <section
        className="rounded-2xl border border-border bg-background p-5 shadow-xs"
        data-testid="mcp-claim-blocked"
        role="status"
      >
        <h2 className="text-sm font-semibold text-foreground">
          {t("page.blocked.title")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("page.blocked.body")}
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4" data-testid="mcp-claim-flow">
      {started ? (
        <McpClaimInstructionsCard
          busy={busy}
          claim={started.claim}
          instructions={started.instructions}
          onVerify={verify}
        />
      ) : null}

      <section className="rounded-2xl border border-border bg-background p-5 shadow-xs">
        <McpClaimMethods
          busy={busy}
          error={error}
          errorCode={errorCode}
          methods={overview.methods}
          onClaimGithub={claimGithub}
          onGrantOrgScope={() => linkGithub(["read:org"])}
          onLinkGithub={() => linkGithub()}
          onStartDomain={startDomain}
        />
      </section>

      <McpClaimList
        busy={busy}
        claims={overview.viewerClaims}
        onVerify={verify}
      />
    </div>
  );
}
