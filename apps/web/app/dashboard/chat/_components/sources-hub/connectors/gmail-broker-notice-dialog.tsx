import { useTranslations } from "next-intl";

import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";

import type { ConnectorCatalogItem } from "./types";

/**
 * Shown before redirecting to Google for a Gmail manifest whose authorization
 * is brokered through Composio (`auth.kind === "brokered"`,
 * `auth.broker === "composio"`): Google's consent screen names Composio, not
 * SourceWeft, so the admin needs this explained before Continue sends them
 * there. Mirrors the mode-choice dialog's title/description/button pattern.
 */
export function GmailBrokerNoticeDialog({
  item,
  onContinue,
  onOpenChange,
}: {
  item: ConnectorCatalogItem | null;
  onContinue: (item: ConnectorCatalogItem) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");

  return (
    <Dialog onOpenChange={onOpenChange} open={item !== null}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("connectors.gmail.brokerNoticeTitle")}</DialogTitle>
          <DialogDescription>
            {t("connectors.gmail.brokerNoticeBody")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("connectors.gmail.modeCancel")}
          </Button>
          <Button
            onClick={() => {
              if (!item) return;
              onContinue(item);
            }}
            type="button"
          >
            {t("connectors.gmail.brokerNoticeContinue")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
