"use client";

import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";
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
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
      <Bot className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{t("enable.title")}</p>
      <p className="max-w-md text-sm text-muted-foreground">
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
