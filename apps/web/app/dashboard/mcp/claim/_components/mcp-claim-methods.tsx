"use client";

import { Globe, Link2, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import type { McpClaimMethod, McpClaimOverview } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import { GitHubIcon } from "../../../../_components/brand-icons";

/**
 * How an unclaimed server's publisher proves it is theirs: with the GitHub
 * account it is published under, or by publishing a token on its domain.
 * Cards appear only for the methods that apply to this entry.
 */
export function McpClaimMethods({
  busy,
  error,
  errorCode,
  methods,
  onClaimGithub,
  onGrantOrgScope,
  onLinkGithub,
  onStartDomain,
}: {
  busy: boolean;
  error: string | null;
  errorCode: string | null;
  methods: McpClaimOverview["methods"];
  onClaimGithub: () => void;
  onGrantOrgScope: () => void;
  onLinkGithub: () => void;
  onStartDomain: (method: Extract<McpClaimMethod, "dns_txt" | "well_known">) => void;
}) {
  const t = useTranslations("dashboardMcpClaim.page");
  const github = methods.github;
  const showGithub = github.available || github.reason === "not_linked";
  const showDomain = methods.domain.available;

  return (
    <div className="space-y-4" data-testid="mcp-claim-methods">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("methodsTitle")}
      </h3>

      {!showGithub && !showDomain ? (
        <p className="text-sm text-muted-foreground">{t("noMethods")}</p>
      ) : null}

      {showGithub ? (
        <div
          className="rounded-lg border border-border p-4 text-xs"
          data-testid="mcp-claim-github"
        >
          <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <GitHubIcon className="size-4" />
            {t("github.title")}
          </h4>
          <p className="mt-1 text-muted-foreground">{t("github.body")}</p>
          {github.owner ? (
            <p className="mt-2 text-foreground">
              {t("github.owner", { owner: github.owner })}
            </p>
          ) : null}
          {github.reason === "not_linked" ? (
            <p className="mt-2 text-amber-700 dark:text-amber-300">
              {t("github.notLinked")}
            </p>
          ) : null}
          {errorCode === "MCP_CLAIM_GITHUB_ORG_SCOPE" ? (
            <p className="mt-2 text-amber-700 dark:text-amber-300">
              {t("github.orgScope")}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {github.reason === "not_linked" ? (
              <Button
                disabled={busy}
                onClick={onLinkGithub}
                size="sm"
                type="button"
                variant="outline"
              >
                <Link2 className="size-3.5" />
                {t("github.link")}
              </Button>
            ) : (
              <Button
                disabled={busy || !github.available}
                onClick={onClaimGithub}
                size="sm"
                type="button"
              >
                <GitHubIcon className="size-3.5" />
                {t("github.action")}
              </Button>
            )}
            {errorCode === "MCP_CLAIM_GITHUB_ORG_SCOPE" ? (
              <Button
                disabled={busy}
                onClick={onGrantOrgScope}
                size="sm"
                type="button"
                variant="outline"
              >
                <ShieldCheck className="size-3.5" />
                {t("github.grantOrg")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showDomain ? (
        <div
          className="rounded-lg border border-border p-4 text-xs"
          data-testid="mcp-claim-domain"
        >
          <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Globe className="size-4" />
            {t("domain.title")}
          </h4>
          <p className="mt-1 text-muted-foreground">{t("domain.body")}</p>
          {methods.domain.domain ? (
            <p className="mt-2 font-mono text-foreground">
              {t("domain.domain", { domain: methods.domain.domain })}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => onStartDomain("dns_txt")}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("domain.dns")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => onStartDomain("well_known")}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("domain.wellKnown")}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
