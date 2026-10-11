"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { OwnerSkillListing } from "@sourceweft/contracts";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";

import { publicWebBaseUrl } from "../../../../lib/public-runtime-config";
import { contentClient } from "../../../../lib/sdk";
import { CatalogBadgeSnippet } from "../../../_components/market/catalog-badge-snippet";
import { ownerListingView } from "./skill-market-standing";

/**
 * The author's say over whether their claimed community skill may be on the
 * public market. Only the claimant of the skill's repository has it: whether
 * an unclaimed skill is public is decided by the platform's rules and market
 * admins, not by whoever imported it.
 *
 * Mounted for every community skill; the route answers 404 for anyone who is
 * not the author — the importer of an unclaimed skill included — and then
 * this renders nothing, so nobody else learns it exists.
 *
 * While the skill is listed, the author also gets its "Listed on SourceWeft"
 * README badge: `slug` is the skill's public market slug.
 */
export function SkillOwnerListing({
  workspaceId,
  catalogId,
  slug,
  onChanged,
}: {
  workspaceId: string;
  catalogId: string;
  slug: string;
  onChanged?: () => void;
}) {
  const t = useTranslations("dashboardSkillsMarket");
  const tb = useTranslations("catalogBadge");
  const [listing, setListing] = React.useState<OwnerSkillListing | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setListing(null);
    contentClient
      .getOwnerSkillListing(workspaceId, catalogId)
      .then((result) => {
        if (!cancelled) setListing(result);
      })
      .catch(() => {
        // Not the owner (404), or not reachable: there is nothing to offer.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, catalogId]);

  if (!listing) return null;
  const view = ownerListingView(listing);

  async function change(allowed: boolean) {
    setBusy(true);
    try {
      setListing(
        await contentClient.setOwnerSkillListing(
          workspaceId,
          catalogId,
          allowed,
        ),
      );
      toast.success(
        allowed
          ? t("ownerListing.allowedToast")
          : t("ownerListing.privateToast"),
      );
      onChanged?.();
    } catch {
      toast.error(t("ownerListing.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mt-4 rounded-lg border border-border p-4"
      data-testid="skill-owner-listing"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-xs">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="skill-owner-listing-switch"
          >
            {t("ownerListing.label")}
          </label>
          <p className="mt-1 text-muted-foreground">
            {t(`ownerListing.${view.state}`)}
          </p>
        </div>
        <Switch
          checked={view.allowed}
          disabled={busy || view.locked}
          id="skill-owner-listing-switch"
          onCheckedChange={(checked) => void change(checked)}
        />
      </div>
      {view.state === "listed" ? (
        <CatalogBadgeSnippet
          className="mt-4 border-t border-border pt-4"
          display="inline"
          intro={tb("ownerHint")}
          siteUrl={publicWebBaseUrl()}
          surface="skill_owner"
          target={{ kind: "skill", key: slug }}
        />
      ) : null}
    </section>
  );
}
