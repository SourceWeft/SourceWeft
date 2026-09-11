import { useEffect, useState } from "react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { SkillAvatar } from "../../../../skills/_components/skill-avatar";
import { SkillIntroduction } from "../../../../skills/_components/skill-introduction";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Loader2 } from "lucide-react";

import { contentClient } from "../../../../../../lib/sdk";
import { getErrorMessage } from "../lib/errors";

export function SkillReadmeDialog({
  catalogId,
  onOpenChange,
  open,
  workspaceId,
}: {
  catalogId: string | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceId?: string | null;
}) {
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof contentClient.getSkillCatalogDetail>
  > | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open || !workspaceId || !catalogId) {
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setDetail(null);
    setError(null);
    contentClient
      .getSkillCatalogDetail(workspaceId, catalogId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setError(getErrorMessage(error, "Failed to load skill details."));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogId, open, workspaceId, reload]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid max-h-[min(720px,calc(100svh-2rem))] w-[720px] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b px-5 py-4 text-left">
          <div className="flex items-center gap-3">
            {detail ? <SkillAvatar item={detail.skill} /> : null}
            <DialogTitle>{detail?.skill.displayName ?? "Skill"}</DialogTitle>
          </div>
          <DialogDescription>
            {detail?.skill.description ??
              "Review this skill before selecting it."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-14 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading skill...
            </div>
          ) : error ? (
            <div role="alert" className="space-y-3 py-8 text-sm">
              <p className="text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReload((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : detail ? (
            <SkillIntroduction
              key={catalogId}
              {...detail}
              displayName={detail.skill.displayName}
              description={detail.skill.description}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
