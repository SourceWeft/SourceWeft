"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RESEARCH_TOPIC_MAX_CHARS } from "@sourceweft/contracts/source-research";
import { HttpClientError } from "@sourceweft/sdk";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { contentClient } from "../../../../../../lib/sdk";
import { ResearchCard } from "./research-card";
import { useResearchRun } from "./use-research-run";

export function ResearchDialog({
  onOpenChange,
  onSaved,
  open,
  workspaceId,
}: {
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
  workspaceId: string;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [topic, setTopic] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const { run, cancel, error } = useResearchRun(workspaceId, runId);

  const start = async () => {
    const value = topic.trim();
    if (!value || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const result = await contentClient.startResearch(workspaceId, value);
      setRunId(result.run.id);
    } catch (caught) {
      setStartError(
        caught instanceof HttpClientError && caught.status === 402
          ? t("research.error.INSUFFICIENT_CREDITS")
          : caught instanceof HttpClientError && caught.status === 503
            ? t("research.error.WEB_PROVIDER_UNAVAILABLE")
            : t("research.startFailed"),
      );
    } finally {
      setStarting(false);
    }
  };

  const save = async () => {
    if (!run || saving) return;
    setSaving(true);
    try {
      await contentClient.saveResearchNote(workspaceId, run.id);
      toast.success(t("research.saved"));
      onSaved();
    } catch {
      toast.error(t("research.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setRunId(null);
    setTopic("");
    setStartError(null);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("research.title")}</DialogTitle>
          <DialogDescription>{t("research.description")}</DialogDescription>
        </DialogHeader>

        {runId === null ? (
          <div className="space-y-2">
            <Input
              maxLength={RESEARCH_TOPIC_MAX_CHARS}
              onChange={(event) => setTopic(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void start();
              }}
              placeholder={t("research.topicPlaceholder")}
              value={topic}
            />
            <p className="text-muted-foreground text-xs">
              {t("research.costNote")}
            </p>
            {startError ? (
              <p className="text-destructive text-sm">{startError}</p>
            ) : null}
            <Button
              disabled={!topic.trim() || starting}
              onClick={() => void start()}
              type="button"
            >
              {starting ? t("research.starting") : t("research.start")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {run ? (
              <ResearchCard onCancel={cancel} run={run} />
            ) : (
              <p className="text-muted-foreground text-sm">
                {t("research.starting")}
              </p>
            )}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            {run?.status === "ready" && run.report ? (
              <>
                <div className="max-h-80 overflow-y-auto rounded-md border p-3 text-sm whitespace-pre-wrap">
                  {run.report}
                </div>
                <Button
                  disabled={saving}
                  onClick={() => void save()}
                  type="button"
                >
                  {t("research.saveNote")}
                </Button>
              </>
            ) : null}
            {run &&
            (run.status === "ready" ||
              run.status === "failed" ||
              run.status === "cancelled") ? (
              <Button onClick={reset} type="button" variant="outline">
                {t("research.newResearch")}
              </Button>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
