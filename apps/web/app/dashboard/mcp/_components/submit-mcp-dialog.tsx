"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";

import { submitMcp } from "../../../../lib/market-submit";

/**
 * Lets a user contribute an MCP server by GitHub URL. The backend parses and
 * safety-scans it, then either publishes it immediately or routes it to review.
 */
export function SubmitMcpDialog() {
  const t = useTranslations("dashboardMcpPanel");
  const [open, setOpen] = React.useState(false);
  const [repoUrl, setRepoUrl] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit() {
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      toast.error(t("submit.urlRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitMcp(trimmed);
      if (result.status === "published") {
        toast.success(t("submit.published", { identifier: result.identifier }));
      } else {
        toast.success(
          t("submit.queued", {
            identifier: result.identifier,
            count: result.flags.length,
          }),
        );
      }
      setRepoUrl("");
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("submit.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="h-7 gap-1.5 px-2.5 text-xs" size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" />
          {t("submit.trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("submit.title")}</DialogTitle>
          <DialogDescription>{t("submit.description")}</DialogDescription>
        </DialogHeader>
        <Input
          onChange={(event) => setRepoUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !submitting) {
              void handleSubmit();
            }
          }}
          placeholder="https://github.com/owner/repo"
          value={repoUrl}
        />
        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => void handleSubmit()}
            type="button"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("submit.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
