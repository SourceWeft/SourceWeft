"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import {
  GENERATE_ENTRIES,
  type GenerateEntry,
  type GenerateSource,
} from "./entries";

/**
 * "Generate" in the sources toolbar: makes something from the selected
 * sources. It needs a selection and a conversation, since what it makes
 * belongs to a thread.
 */
export function GenerateMenu({
  workspaceId,
  threadId,
  sources,
  onCreated,
  entries = GENERATE_ENTRIES,
}: {
  workspaceId: string | null | undefined;
  threadId: string | null | undefined;
  /** The selected sources, folders expanded. */
  sources: readonly GenerateSource[];
  onCreated: (artifactId: string) => void;
  entries?: readonly GenerateEntry[];
}) {
  const t = useTranslations("dashboardSourcesHub");
  // The selection is taken when an entry opens; the dialog keeps it.
  const [active, setActive] = useState<{
    entry: GenerateEntry;
    sources: readonly GenerateSource[];
  } | null>(null);

  const blockedReason =
    !workspaceId || !threadId
      ? t("generate.needsThread")
      : sources.length === 0
        ? t("generate.needsSelection")
        : null;
  const ActiveDialog = active?.entry.Dialog;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            data-testid="hub-generate-menu"
            disabled={blockedReason !== null}
            size="xs"
            title={blockedReason ?? t("generate.menu")}
            type="button"
            variant="outline"
          >
            <Sparkles className="size-3.5" />
            {t("generate.button")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {entries.map((entry) => (
            <DropdownMenuItem
              className="whitespace-nowrap"
              key={entry.id}
              onSelect={() => setActive({ entry, sources })}
            >
              <entry.icon className="size-4" />
              {t(`generate.${entry.labelKey}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {ActiveDialog && active && workspaceId && threadId ? (
        <ActiveDialog
          onCreated={onCreated}
          onOpenChange={(open) => {
            if (!open) setActive(null);
          }}
          open
          sources={active.sources}
          threadId={threadId}
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  );
}
