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
import { publicWebBaseUrl } from "../../../../lib/public-runtime-config";
import { CatalogBadgeSnippet } from "../../../_components/market/catalog-badge-snippet";

/**
 * Lets a user contribute an MCP server by GitHub URL. The backend parses and
 * safety-scans it, then either publishes it immediately or routes it to review.
 * A published server is on the public market at once, so the dialog stays open
 * to hand its author the server's README badge; one sent to review has none yet.
 * A server published after its author closed the dialog gets a toast instead.
 */
export function SubmitMcpDialog() {
  const t = useTranslations("dashboardMcpPanel");
  const tb = useTranslations("catalogBadge");
  const [open, setOpen] = React.useState(false);
  const [repoUrl, setRepoUrl] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  // The identifier of the server just published, while the dialog shows it.
  const [published, setPublished] = React.useState<string | null>(null);
  // Whether the dialog is open now, for a submission that settles later.
  const openRef = React.useRef(open);

  function changeOpen(next: boolean) {
    openRef.current = next;
    setOpen(next);
    // Reset on the way in: closing content stays on screen while it animates.
    if (next) setPublished(null);
  }

  async function handleSubmit() {
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      toast.error(t("submit.urlRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitMcp(trimmed);
      setRepoUrl("");
      if (result.status === "published") {
        if (openRef.current) {
          setPublished(result.identifier);
        } else {
          toast.success(
            t("submit.published", { identifier: result.identifier }),
          );
        }
      } else {
        toast.success(
          t("submit.queued", {
            identifier: result.identifier,
            count: result.flags.length,
          }),
        );
        changeOpen(false);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("submit.failed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="h-7 gap-1.5 px-2.5 text-xs" size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" />
          {t("submit.trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        {published ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("submit.title")}</DialogTitle>
              <DialogDescription>
                {t("submit.published", { identifier: published })}
              </DialogDescription>
            </DialogHeader>
            <CatalogBadgeSnippet
              className="min-w-0"
              display="inline"
              intro={tb("submitHint")}
              siteUrl={publicWebBaseUrl()}
              surface="mcp_submit"
              target={{ kind: "mcp", key: published }}
            />
            <DialogFooter>
              <Button onClick={() => changeOpen(false)} type="button">
                {t("submit.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
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
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t("submit.submit")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
