"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import type {
  CreateThreadShareRequest,
  ThreadShare,
  UpdateThreadShareRequest,
} from "@sourceweft/contracts";
import { formatDisplayDate } from "../../../lib/i18n/format";
import { contentClient } from "../../../lib/sdk";

/** The slice of ContentClient this dialog needs; tests inject a stub. */
export type ShareChatDialogClient = {
  getThreadShare: (
    workspaceId: string,
    threadId: string,
  ) => Promise<{ share: ThreadShare | null }>;
  shareThread: (
    workspaceId: string,
    threadId: string,
    input?: CreateThreadShareRequest,
  ) => Promise<{ share: ThreadShare }>;
  updateThreadShare: (
    workspaceId: string,
    threadId: string,
    input: UpdateThreadShareRequest,
  ) => Promise<{ share: ThreadShare }>;
  revokeThreadShare: (
    workspaceId: string,
    threadId: string,
  ) => Promise<{ revoked: true }>;
};

const SNAPSHOT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
};

/**
 * Publish or revoke a frozen public snapshot of one chat. Unlike the
 * artifact share dialog, (re-)sharing always captures the thread's current
 * messages: later turns stay private until the owner explicitly updates the
 * link, so "Create link"/"Update link" is one action, not a persistent
 * on/off switch.
 */
export function ShareChatDialog({
  open,
  onOpenChange,
  workspaceId,
  chatId,
  chatTitle,
  client = contentClient,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  chatId: string;
  chatTitle: string;
  client?: ShareChatDialogClient;
}) {
  const t = useTranslations("dashboardNav");
  const locale = useLocale();
  const [loading, setLoading] = React.useState(false);
  const [share, setShare] = React.useState<ThreadShare | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);
  const [confirmingStop, setConfirmingStop] = React.useState(false);

  // The dialog is a single, unkeyed instance reused across chats (the panel
  // just swaps which chat it's open for). A result for a chat the dialog has
  // since moved away from must never be applied — this ref always holds the
  // chat id the current render is actually showing, so an async handler can
  // tell a stale response apart from a current one after it awaits.
  const chatIdRef = React.useRef(chatId);
  chatIdRef.current = chatId;

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Drop the previous chat's share before looking up this one, so a failed
    // lookup can never leave another chat's link, views or date on screen.
    setShare(null);
    setForbidden(false);
    setConfirmingStop(false);
    setCopied(false);
    setBusy(false);
    setLoading(true);
    void client
      .getThreadShare(workspaceId, chatId)
      .then((result) => {
        if (!cancelled) setShare(result.share);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if ((error as { status?: number } | null)?.status === 403) {
          setForbidden(true);
        } else {
          toast.error(t("chats.shareDialog.updateError"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, chatId, client, t]);

  async function handleShare() {
    const requestChatId = chatId;
    setBusy(true);
    setForbidden(false);
    try {
      const result = await client.shareThread(workspaceId, chatId, {});
      if (chatIdRef.current !== requestChatId) return;
      setShare(result.share);
    } catch (error) {
      if (chatIdRef.current !== requestChatId) return;
      if ((error as { status?: number }).status === 403) {
        setForbidden(true);
      } else {
        toast.error(t("chats.shareDialog.updateError"));
      }
    } finally {
      if (chatIdRef.current === requestChatId) setBusy(false);
    }
  }

  async function handleAllowSearchEngines(allow: boolean) {
    if (!share) return;
    const requestChatId = chatId;
    const previous = share;
    setShare({ ...share, noindex: !allow });
    try {
      const result = await client.updateThreadShare(workspaceId, chatId, {
        noindex: !allow,
      });
      if (chatIdRef.current !== requestChatId) return;
      setShare(result.share);
    } catch {
      if (chatIdRef.current !== requestChatId) return;
      setShare(previous);
      toast.error(t("chats.shareDialog.updateError"));
    }
  }

  async function handleCopy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("chats.shareDialog.updateError"));
    }
  }

  async function handleConfirmStopSharing() {
    const requestChatId = chatId;
    setBusy(true);
    try {
      await client.revokeThreadShare(workspaceId, chatId);
      if (chatIdRef.current !== requestChatId) return;
      setShare(null);
      setConfirmingStop(false);
    } catch {
      if (chatIdRef.current !== requestChatId) return;
      toast.error(t("chats.shareDialog.updateError"));
    } finally {
      if (chatIdRef.current === requestChatId) setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[520px] max-w-[calc(100%-2rem)] gap-5 p-5"
        constrainWidth={false}
      >
        <DialogHeader className="text-left">
          <DialogTitle>{t("chats.shareDialog.title")}</DialogTitle>
          <DialogDescription className="truncate">
            {chatTitle}
          </DialogDescription>
        </DialogHeader>

        {loading ? null : forbidden ? (
          <p className="text-sm text-destructive">
            {t("chats.shareDialog.forbidden")}
          </p>
        ) : confirmingStop ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("chats.shareDialog.stopSharingConfirm")}
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmingStop(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void handleConfirmStopSharing()}
                type="button"
                variant="destructive"
              >
                {t("chats.shareDialog.stopSharing")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {!share ? (
              <p className="text-sm text-muted-foreground">
                {t("chats.shareDialog.notSharedDescription")}
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-stretch overflow-hidden rounded-lg border bg-muted/40 focus-within:ring-2 focus-within:ring-ring/40">
                    <input
                      readOnly
                      className="h-9 min-w-0 flex-1 bg-transparent px-3 text-xs text-foreground outline-none"
                      onFocus={(event) => event.currentTarget.select()}
                      value={share.url}
                    />
                    <Button
                      className="h-9 shrink-0 rounded-none border-y-0 border-r-0 border-l"
                      onClick={() => void handleCopy()}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {copied ? (
                        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      {copied
                        ? t("chats.shareDialog.copied")
                        : t("chats.shareDialog.copy")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("chats.shareDialog.snapshotFrom", {
                      date: formatDisplayDate(
                        new Date(share.snapshotTakenAt),
                        locale,
                        SNAPSHOT_DATE_OPTIONS,
                      ),
                    })}
                  </p>
                </div>

                <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border p-4">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {t("chats.shareDialog.allowSearchEngines")}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {t("chats.shareDialog.allowSearchEnginesOff")}
                    </span>
                  </span>
                  <Switch
                    checked={!share.noindex}
                    onCheckedChange={(checked) =>
                      void handleAllowSearchEngines(checked)
                    }
                  />
                </label>

                <p className="text-xs text-muted-foreground">
                  {t("chats.shareDialog.views", { count: share.viewCount })}
                </p>
              </>
            )}

            <DialogFooter className="sm:justify-between">
              {share ? (
                <Button
                  onClick={() => setConfirmingStop(true)}
                  type="button"
                  variant="ghost"
                >
                  {t("chats.shareDialog.stopSharing")}
                </Button>
              ) : (
                <span />
              )}
              <Button
                disabled={busy}
                onClick={() => void handleShare()}
                type="button"
              >
                {share
                  ? t("chats.shareDialog.updateLink")
                  : t("chats.shareDialog.createLink")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
