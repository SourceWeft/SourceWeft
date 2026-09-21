"use client";

import * as React from "react";
import { toast } from "sonner";
import type { OwnerSkillListing } from "@sourceweft/contracts";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";

import { contentClient } from "../../../../lib/sdk";
import { ownerListingView } from "./skill-market-standing";
import { skillsMarketCopy } from "./skills-market-copy";

const copy = skillsMarketCopy.ownerListing;

/**
 * The author's say over whether their claimed community skill may be on the
 * public market. Only the claimant of the skill's repository has it: whether
 * an unclaimed skill is public is decided by the platform's rules and market
 * admins, not by whoever imported it.
 *
 * Mounted for every community skill; the route answers 404 for anyone who is
 * not the author — the importer of an unclaimed skill included — and then
 * this renders nothing, so nobody else learns it exists.
 */
export function SkillOwnerListing({
  workspaceId,
  catalogId,
  onChanged,
}: {
  workspaceId: string;
  catalogId: string;
  onChanged?: () => void;
}) {
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
      toast.success(allowed ? copy.allowedToast : copy.privateToast);
      onChanged?.();
    } catch {
      toast.error(copy.failed);
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
            {copy.label}
          </label>
          <p className="mt-1 text-muted-foreground">{copy[view.state]}</p>
        </div>
        <Switch
          checked={view.allowed}
          disabled={busy || view.locked}
          id="skill-owner-listing-switch"
          onCheckedChange={(checked) => void change(checked)}
        />
      </div>
    </section>
  );
}
