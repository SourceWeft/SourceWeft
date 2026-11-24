"use client";

import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { useAssistantMutations } from "../../../../lib/assistant";
import { useAssistantAction } from "./use-assistant-actions";

/**
 * Shown while the workspace has no assistant. Only a workspace admin may
 * enable it, so everyone else is told whom to ask instead of being offered
 * a button the server would refuse.
 */
export function EnableCard({
  workspaceId,
  isAdmin,
}: {
  workspaceId: string | null;
  isAdmin: boolean;
}) {
  const t = useTranslations("dashboardAssistant");
  const { enable } = useAssistantMutations(workspaceId);
  const { run } = useAssistantAction();

  return (
    <div className="flex max-w-md flex-col items-start gap-3 py-6 md:py-10">
      <h2 className="text-base font-semibold">{t("enable.title")}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("enable.body")}
      </p>
      {isAdmin ? (
        <Button
          disabled={!workspaceId || enable.isPending}
          onClick={() =>
            void run(() => enable.mutateAsync(undefined), t("toasts.enabled"))
          }
        >
          {t("enable.button")}
        </Button>
      ) : (
        <p className="text-sm font-medium">{t("enable.askAdmin")}</p>
      )}
    </div>
  );
}
