import { useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { redactUrlQuery } from "@sourceweft/contracts";
import { HttpClientError } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Label } from "@sourceweft/ui-web/components/ui/label";

import { getErrorMessage } from "../lib/errors";
import type { FeedCheckResult } from "./types";

const FEED_URL_MAX_LENGTH = 2048;

/** Reasons the readiness check can report that have their own copy. */
const FEED_FAILURE_REASONS = [
  "feed_blocked_address",
  "feed_timeout",
  "feed_too_large",
  "feed_not_a_feed",
  "feed_http_error",
  "feed_unreachable",
  "feed_https_required",
] as const;

/** Server-side URL rejections: same copy as the client-side pre-check. */
const FEED_URL_REASONS = new Set([
  "feed_url_invalid",
  "feed_credentials_not_allowed",
]);

/** The same rules the server applies: https only, no `user:pass@`. */
function isAcceptableFeedUrl(value: string) {
  if (value.length === 0 || value.length > FEED_URL_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === ""
  );
}

function hostOf(feedUrl: string) {
  try {
    return new URL(feedUrl).host;
  } catch {
    return "";
  }
}

type Checked = { feedUrl: string; result: FeedCheckResult };

function AddFeedForm({
  onAdd,
  onCheck,
  onOpenChange,
}: Pick<Parameters<typeof AddFeedDialog>[0], "onAdd" | "onCheck"> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [feedUrl, setFeedUrl] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [urlRejected, setUrlRejected] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Only the latest check may settle: a URL edit or a newer check bumps it.
  const checkSeq = useRef(0);

  const trimmedUrl = feedUrl.trim();
  const result =
    checked && checked.feedUrl === trimmedUrl ? checked.result : null;
  const canAdd = result?.ready === true && !isChecking && !isAdding;

  function handleUrlChange(value: string) {
    checkSeq.current += 1;
    setFeedUrl(value);
    setIsChecking(false);
    setUrlRejected(false);
    setCheckError(false);
    setAddError(null);
  }

  async function handleCheck() {
    setAddError(null);
    setCheckError(false);
    if (!isAcceptableFeedUrl(trimmedUrl)) {
      setUrlRejected(true);
      return;
    }
    setUrlRejected(false);
    const seq = (checkSeq.current += 1);
    setIsChecking(true);
    try {
      const next = await onCheck(trimmedUrl);
      if (seq !== checkSeq.current) return;
      setChecked({ feedUrl: trimmedUrl, result: next });
      if (next.ready && !nameTouched) setName(next.title ?? "");
    } catch {
      if (seq !== checkSeq.current) return;
      setChecked(null);
      setCheckError(true);
    } finally {
      if (seq === checkSeq.current) setIsChecking(false);
    }
  }

  async function handleAdd() {
    if (!result?.ready) return;
    setAddError(null);
    setIsAdding(true);
    try {
      await onAdd({
        name: name.trim() || result.title || hostOf(trimmedUrl),
        feedUrl: trimmedUrl,
      });
      onOpenChange(false);
    } catch (error) {
      setAddError(
        error instanceof HttpClientError &&
          error.code === "CONNECTOR_ALREADY_EXISTS"
          ? t("connectors.rss.dialog.nameConflict")
          : getErrorMessage(error, t("connectors.rss.dialog.addFailed")),
      );
    } finally {
      setIsAdding(false);
    }
  }

  function failureText(reason: string) {
    if ((FEED_FAILURE_REASONS as readonly string[]).includes(reason)) {
      return t(`connectors.readiness.${reason}`);
    }
    if (FEED_URL_REASONS.has(reason)) {
      return t("connectors.rss.dialog.invalidUrl");
    }
    return t("connectors.readinessNotReady");
  }

  const errorText = urlRejected
    ? t("connectors.rss.dialog.invalidUrl")
    : checkError
      ? t("connectors.rss.dialog.checkFailed")
      : result && !result.ready
        ? failureText(result.reason)
        : addError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.cta.addFeed")}</DialogTitle>
        <DialogDescription>
          {t("connectors.rss.dialog.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAdd) void handleAdd();
          else if (!isChecking && trimmedUrl) void handleCheck();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="add-feed-url">{t("connectors.rss.feedUrl")}</Label>
          <div className="flex gap-2">
            <Input
              autoComplete="off"
              id="add-feed-url"
              name="feedUrl"
              onChange={(event) => handleUrlChange(event.target.value)}
              placeholder="https://example.com/feed.xml"
              type="url"
              value={feedUrl}
            />
            <Button
              disabled={isChecking || isAdding || trimmedUrl === ""}
              onClick={() => void handleCheck()}
              type="button"
              variant="outline"
            >
              {isChecking ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("connectors.rss.dialog.checking")}
                </>
              ) : (
                t("connectors.rss.dialog.check")
              )}
            </Button>
          </div>
        </div>

        {result?.ready ? (
          <div className="flex items-start gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {result.title ?? t("connectors.rss.dialog.found")}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {result.itemCount !== null
                  ? `${t("connectors.rss.dialog.itemCount", {
                      count: result.itemCount,
                    })} · `
                  : ""}
                {redactUrlQuery(trimmedUrl)}
              </p>
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="add-feed-name">
            {t("connectors.rss.dialog.nameLabel")}
          </Label>
          <Input
            autoComplete="off"
            id="add-feed-name"
            maxLength={200}
            name="feedName"
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
            }}
            value={name}
          />
        </div>

        {errorText ? (
          <Alert variant="destructive">
            <AlertDescription>{errorText}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("common.cancel")}
          </Button>
          <Button disabled={!canAdd} type="submit">
            {isAdding ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.cta.addFeed")}
              </>
            ) : (
              t("connectors.cta.addFeed")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Presentational add-feed dialog for add-only connector types: the parent
 * supplies the check and create calls. The query part of the feed URL may hold
 * a token, so it is only ever sent to those callbacks and never rendered; the
 * result block shows the URL without its query.
 */
export function AddFeedDialog({
  open,
  onOpenChange,
  onCheck,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheck: (feedUrl: string) => Promise<FeedCheckResult>;
  onAdd: (input: { name: string; feedUrl: string }) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        {/* Rendered inside the content so each open starts with a fresh form. */}
        <AddFeedForm
          onAdd={onAdd}
          onCheck={onCheck}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
