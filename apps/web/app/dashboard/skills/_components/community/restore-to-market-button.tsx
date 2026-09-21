"use client";

import * as React from "react";
import { Loader2, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { RestoreSkillRepoToMarketResponse } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import {
  errorMessage,
  restoreClaimedRepoToMarket,
} from "../../../../../lib/skill-market-audit";

/**
 * "Restore to SourceWeft" for a repository its author removed: it may be
 * imported again, and the skills the author held are released. Nothing is
 * listed on the spot — the platform's rules list them on the next upkeep
 * pass, and a market admin's withdrawal stays.
 */
export function RestoreToMarketButton({
  workspaceId,
  claimId,
  onRestored,
  className,
}: {
  workspaceId: string;
  claimId: string;
  onRestored?: (result: RestoreSkillRepoToMarketResponse) => void;
  className?: string;
}) {
  const t = useTranslations("dashboardSkillsMarketAdmin");
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        restoreClaimedRepoToMarket(workspaceId, claimId)
          .then((result) => {
            toast.success(
              result.skillCount > 0
                ? t("restore.restored", { count: result.skillCount })
                : t("restore.nothing"),
            );
            onRestored?.(result);
          })
          .catch((error: unknown) => {
            toast.error(errorMessage(error, t("restore.failed")));
          })
          .finally(() => setBusy(false));
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Undo2 className="size-3.5" />
      )}
      {t("restore.button")}
    </Button>
  );
}
