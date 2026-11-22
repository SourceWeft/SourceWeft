"use client";

import { Telescope } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";

/** The Research button of the sources panel; absent when the deployment has no web provider. */
export function ResearchEntry({
  available,
  disabled,
  onOpen,
}: {
  available: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  if (!available) return null;
  return (
    <Button
      disabled={disabled}
      onClick={onOpen}
      size="xs"
      type="button"
      variant="outline"
    >
      <Telescope className="size-3.5" />
      {t("research.add")}
    </Button>
  );
}
