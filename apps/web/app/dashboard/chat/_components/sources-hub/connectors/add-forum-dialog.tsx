import { useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { HttpClientError } from "@sourceweft/sdk";
import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { Label } from "@sourceweft/ui-web/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@sourceweft/ui-web/components/ui/radio-group";

import { getErrorMessage } from "../lib/errors";
import {
  DISCOURSE_CONNECTOR_TYPE,
  DISCOURSE_FORUM_URL_MAX_LENGTH,
  isAcceptableForumUrl,
} from "./discourse-forum-url";
import type { ForumAddInput, ForumCheckInput, ForumCheckResult } from "./types";

const DEFAULT_NAME = "Discourse";

type RefreshMode = "light" | "deep";

/** Failure reasons the readiness check can report that have their own copy.
 * `selection_required` is not one: it means the forum is reachable. */
const FORUM_FAILURE_REASONS = [
  "login_required",
  "not_a_discourse_site",
  "forum_unreachable",
  "blocked_endpoint",
  "rate_limited",
  "config_invalid",
] as const;

type Checked = {
  forumUrl: string;
  refresh: RefreshMode;
  result: ForumCheckResult;
};

function isReachable(result: ForumCheckResult) {
  // A reachable forum with nothing chosen yet is not "ready" to sync, but it
  // is what a first check is expected to find.
  return result.ready || result.reason === "selection_required";
}

function hostOf(forumUrl: string) {
  try {
    return new URL(forumUrl).host;
  } catch {
    return forumUrl;
  }
}

function AddForumForm({
  onAdd,
  onCheck,
  onOpenChange,
}: Pick<Parameters<typeof AddForumDialog>[0], "onAdd" | "onCheck"> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [forumUrl, setForumUrl] = useState("");
  const [refresh, setRefresh] = useState<RefreshMode>("light");
  const [name, setName] = useState(DEFAULT_NAME);
  // Scheduled reconciliation is opt-in: the connector only keeps syncing on a
  // schedule when the member asks.
  const [autoSync, setAutoSync] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  // Set synchronously on the first Add so a second click or submit in the same
  // tick cannot send another create before the disabled state renders.
  const addingRef = useRef(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [urlRejected, setUrlRejected] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Only the latest check may settle: an input edit or a newer check bumps it.
  const checkSeq = useRef(0);

  const trimmedUrl = forumUrl.trim();
  // A check only counts for the exact inputs it ran with.
  const result =
    checked && checked.forumUrl === trimmedUrl && checked.refresh === refresh
      ? checked.result
      : null;
  const reachable = result !== null && isReachable(result);
  const urlInvalid = trimmedUrl !== "" && !isAcceptableForumUrl(trimmedUrl);
  const canAdd = reachable && !isChecking && !isAdding;

  function invalidateCheck() {
    checkSeq.current += 1;
    setIsChecking(false);
    setUrlRejected(false);
    setCheckError(false);
    setAddError(null);
  }

  // Categories and topics are chosen after the connector exists, so the check
  // and the create both carry an empty selection.
  function buildInput(): ForumCheckInput {
    return {
      connectorType: DISCOURSE_CONNECTOR_TYPE,
      configJson: { forumUrl: trimmedUrl, items: [], refresh },
    };
  }

  async function handleCheck() {
    setAddError(null);
    setCheckError(false);
    if (!isAcceptableForumUrl(trimmedUrl)) {
      setUrlRejected(true);
      return;
    }
    setUrlRejected(false);
    const seq = (checkSeq.current += 1);
    setIsChecking(true);
    try {
      const next = await onCheck(buildInput());
      if (seq !== checkSeq.current) return;
      setChecked({ forumUrl: trimmedUrl, refresh, result: next });
    } catch {
      if (seq !== checkSeq.current) return;
      setChecked(null);
      setCheckError(true);
    } finally {
      if (seq === checkSeq.current) setIsChecking(false);
    }
  }

  async function handleAdd() {
    if (!reachable || addingRef.current) return;
    addingRef.current = true;
    setAddError(null);
    setIsAdding(true);
    try {
      const input: ForumAddInput = {
        ...buildInput(),
        name: name.trim() || DEFAULT_NAME,
        periodicIndexingEnabled: autoSync,
      };
      await onAdd(input);
      onOpenChange(false);
    } catch (error) {
      setAddError(
        error instanceof HttpClientError &&
          error.code === "CONNECTOR_ALREADY_EXISTS"
          ? t("connectors.discourse.dialog.nameConflict")
          : getErrorMessage(error, t("connectors.discourse.dialog.addFailed")),
      );
    } finally {
      addingRef.current = false;
      setIsAdding(false);
    }
  }

  function failureText(reason: string) {
    if ((FORUM_FAILURE_REASONS as readonly string[]).includes(reason)) {
      return t(`connectors.discourse.readiness.${reason}`);
    }
    return t("connectors.readinessNotReady");
  }

  const errorText = urlRejected
    ? t("connectors.discourse.dialog.invalidUrl")
    : checkError
      ? t("connectors.discourse.dialog.checkFailed")
      : result && !reachable
        ? failureText(result.reason)
        : addError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.discourse.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.discourse.dialog.description")}
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
          <Label htmlFor="add-forum-url">
            {t("connectors.discourse.forumUrlLabel")}
          </Label>
          <div className="flex gap-2">
            <Input
              aria-describedby="add-forum-url-hint"
              aria-invalid={urlInvalid}
              autoComplete="off"
              id="add-forum-url"
              inputMode="url"
              maxLength={DISCOURSE_FORUM_URL_MAX_LENGTH + 64}
              name="forumUrl"
              onChange={(event) => {
                setForumUrl(event.target.value);
                invalidateCheck();
              }}
              placeholder="https://forum.example.com"
              value={forumUrl}
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
                  {t("connectors.discourse.dialog.checking")}
                </>
              ) : (
                t("connectors.discourse.dialog.check")
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" id="add-forum-url-hint">
            {t("connectors.discourse.forumUrlHint")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("connectors.discourse.dialog.privateNote")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label id="add-forum-refresh-label">
            {t("connectors.discourse.refreshLabel")}
          </Label>
          <RadioGroup
            aria-labelledby="add-forum-refresh-label"
            className="grid gap-2"
            onValueChange={(value) => {
              setRefresh(value === "deep" ? "deep" : "light");
              invalidateCheck();
            }}
            value={refresh}
          >
            {(["light", "deep"] as const).map((option) => (
              <label
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-xs has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/40"
                htmlFor={`add-forum-refresh-${option}`}
                key={option}
              >
                <RadioGroupItem
                  className="mt-0.5"
                  id={`add-forum-refresh-${option}`}
                  value={option}
                />
                <span className="space-y-0.5">
                  <span className="block font-medium text-foreground">
                    {option === "light"
                      ? t("connectors.discourse.refreshLight")
                      : t("connectors.discourse.refreshDeep")}
                  </span>
                  <span className="block text-muted-foreground">
                    {option === "light"
                      ? t("connectors.discourse.refreshLightHint")
                      : t("connectors.discourse.refreshDeepHint")}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>

        {reachable ? (
          <>
            <div className="flex items-start gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {t("connectors.discourse.dialog.reachable")}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {hostOf(trimmedUrl)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.discourse.dialog.reachableHint")}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="add-forum-name">
                {t("connectors.discourse.nameLabel")}
              </Label>
              <Input
                autoComplete="off"
                id="add-forum-name"
                maxLength={200}
                name="forumName"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                checked={autoSync}
                className="mt-0.5"
                id="add-forum-autosync"
                onCheckedChange={(value) => setAutoSync(value === true)}
              />
              <div className="space-y-0.5">
                <Label className="font-normal" htmlFor="add-forum-autosync">
                  {t("connectors.discourse.dialog.autoSync")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.discourse.dialog.autoSyncHint")}
                </p>
              </div>
            </div>
          </>
        ) : null}

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
                {t("connectors.discourse.dialog.add")}
              </>
            ) : (
              t("connectors.discourse.dialog.add")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Presentational add dialog for a public Discourse forum (`forum_url` add
 * mode): the forum address and a refresh mode, then a "Check forum" readiness
 * check, then the name and schedule and create. The parent supplies the check
 * and create calls. The check carries an empty selection, so a reachable forum
 * reports `selection_required`; that counts as success because the categories
 * and topics are chosen after the connector exists, through the shared
 * selection picker. Editing the address or the refresh mode drops the check.
 */
export function AddForumDialog({
  open,
  onOpenChange,
  onCheck,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheck: (input: ForumCheckInput) => Promise<ForumCheckResult>;
  onAdd: (input: ForumAddInput) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        {/* Rendered inside the content so each open starts with a fresh form. */}
        <AddForumForm
          onAdd={onAdd}
          onCheck={onCheck}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
