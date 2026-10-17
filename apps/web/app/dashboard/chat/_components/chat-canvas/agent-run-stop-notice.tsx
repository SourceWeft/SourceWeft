import { CirclePause, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import type { AgentRunStop } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";

export function AgentRunStopNotice({
  stop,
  disabled = false,
  onContinue,
}: {
  stop: AgentRunStop;
  disabled?: boolean;
  onContinue?: () => void;
}) {
  const t = useTranslations("dashboardChatCanvas");
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-3 text-sm"
    >
      <CirclePause className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">{t("stepLimit.title")}</p>
        <p className="text-muted-foreground">
          {t(
            stop.summaryStatus === "failed"
              ? "stepLimit.summaryFailed"
              : "stepLimit.body",
            { steps: stop.steps, limit: stop.limit },
          )}
        </p>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={disabled || !onContinue}
          onClick={onContinue}
        >
          {t("stepLimit.continue")}
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
