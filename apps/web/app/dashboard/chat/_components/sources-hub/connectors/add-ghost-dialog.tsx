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

import { getErrorMessage } from "../lib/errors";
import {
  GHOST_API_KEY_MAX_LENGTH,
  GHOST_SITE_URL_MAX_LENGTH,
  isAcceptableGhostApiKey,
  isAcceptableGhostSiteUrl,
} from "./ghost-site-url";
import type { GhostAddInput, GhostCheckInput, GhostCheckResult } from "./types";

const DEFAULT_NAME = "Ghost";

/** Readiness reasons that have their own copy (`READINESS_REASONS` in
 * packages/builtin-connector-ghost/src/adapter-error.ts). Anything else falls
 * back to the generic not-ready copy. */
const GHOST_FAILURE_REASONS = [
  "reauth_required",
  "not_a_ghost_site",
  "blocked_endpoint",
  "config_invalid",
  "unreachable",
  "rate_limited",
] as const;

function hostOf(siteUrl: string) {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

type Checked = {
  siteUrl: string;
  secret: string;
  result: GhostCheckResult;
};

function AddGhostForm({
  onAdd,
  onCheck,
  onOpenChange,
}: Pick<Parameters<typeof AddGhostDialog>[0], "onAdd" | "onCheck"> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [siteUrl, setSiteUrl] = useState("");
  // The Content API key is held only here, in local component state, and is
  // cleared after any submit or failure (below). It is never lifted into a
  // query cache, the URL or storage, never logged and never rendered.
  const [secret, setSecret] = useState("");
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
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Only the latest check may settle: an input edit or a newer check bumps it.
  const checkSeq = useRef(0);

  const trimmedUrl = siteUrl.trim();
  // A check only counts for the exact inputs it ran with.
  const result =
    checked && checked.siteUrl === trimmedUrl && checked.secret === secret
      ? checked.result
      : null;
  const urlInvalid = trimmedUrl !== "" && !isAcceptableGhostSiteUrl(trimmedUrl);
  const apiKeyInvalid = secret !== "" && !isAcceptableGhostApiKey(secret);
  const hasCheckInputs = trimmedUrl !== "" && secret !== "";
  const canAdd = result?.ready === true && !isChecking && !isAdding;

  function invalidateCheck() {
    checkSeq.current += 1;
    setIsChecking(false);
    setUrlRejected(false);
    setFieldError(null);
    setCheckError(false);
    setAddError(null);
  }

  async function handleCheck() {
    setAddError(null);
    setCheckError(false);
    if (!isAcceptableGhostSiteUrl(trimmedUrl)) {
      setUrlRejected(true);
      return;
    }
    setUrlRejected(false);
    if (!isAcceptableGhostApiKey(secret)) {
      setFieldError(t("connectors.ghost.dialog.invalidApiKey"));
      return;
    }
    setFieldError(null);
    const seq = (checkSeq.current += 1);
    const checkedSecret = secret;
    setIsChecking(true);
    try {
      const next = await onCheck({
        siteUrl: trimmedUrl,
        secret: checkedSecret,
      } satisfies GhostCheckInput);
      if (seq !== checkSeq.current) return;
      setChecked({ siteUrl: trimmedUrl, secret: checkedSecret, result: next });
    } catch {
      if (seq !== checkSeq.current) return;
      setChecked(null);
      setCheckError(true);
    } finally {
      if (seq === checkSeq.current) setIsChecking(false);
    }
  }

  async function handleAdd() {
    if (!result?.ready || addingRef.current) return;
    addingRef.current = true;
    setAddError(null);
    setIsAdding(true);
    try {
      const input: GhostAddInput = {
        siteUrl: trimmedUrl,
        secret,
        name: name.trim() || DEFAULT_NAME,
        periodicIndexingEnabled: autoSync,
      };
      await onAdd(input);
      // The create succeeded; the dialog is closing, but drop the key and the
      // checked result from state immediately so neither lingers after submit.
      setSecret("");
      setChecked(null);
      onOpenChange(false);
    } catch (error) {
      // The create failed with the key already in flight: clear it so a retry
      // re-enters it deliberately and nothing is retained after a failure.
      setSecret("");
      setChecked(null);
      setAddError(addFailureText(error));
    } finally {
      addingRef.current = false;
      setIsAdding(false);
    }
  }

  function addFailureText(error: unknown): string {
    if (error instanceof HttpClientError) {
      if (error.code === "CONNECTOR_CREDENTIAL_NOT_ALLOWED") {
        return t("connectors.ghost.dialog.credentialNotAllowed");
      }
      // One Ghost connector per site per workspace: the account identity is the
      // site, so a second one for the same site is refused with this code.
      if (error.code === "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS") {
        return t("connectors.ghost.dialog.accountConflict");
      }
      if (error.code === "CONNECTOR_ALREADY_EXISTS") {
        return t("connectors.ghost.dialog.nameConflict");
      }
    }
    return getErrorMessage(error, t("connectors.ghost.dialog.addFailed"));
  }

  function failureText(reason: string) {
    if ((GHOST_FAILURE_REASONS as readonly string[]).includes(reason)) {
      return t(`connectors.ghost.readiness.${reason}`);
    }
    return t("connectors.readinessNotReady");
  }

  const errorText = urlRejected
    ? t("connectors.ghost.dialog.invalidUrl")
    : fieldError
      ? fieldError
      : checkError
        ? t("connectors.ghost.dialog.checkFailed")
        : result && !result.ready
          ? failureText(result.reason)
          : addError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.ghost.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.ghost.dialog.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAdd) void handleAdd();
          else if (!isChecking && hasCheckInputs) void handleCheck();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="add-ghost-url">
            {t("connectors.ghost.siteUrlLabel")}
          </Label>
          <Input
            aria-describedby="add-ghost-url-hint"
            aria-invalid={urlInvalid}
            autoComplete="off"
            id="add-ghost-url"
            inputMode="url"
            maxLength={GHOST_SITE_URL_MAX_LENGTH + 64}
            name="ghostSiteUrl"
            onChange={(event) => {
              setSiteUrl(event.target.value);
              invalidateCheck();
            }}
            placeholder="https://demo.ghost.io"
            type="url"
            value={siteUrl}
          />
          <p className="text-xs text-muted-foreground" id="add-ghost-url-hint">
            {t("connectors.ghost.siteUrlHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="add-ghost-api-key">
            {t("connectors.ghost.apiKeyLabel")}
          </Label>
          <Input
            aria-describedby="add-ghost-api-key-hint"
            aria-invalid={apiKeyInvalid}
            autoComplete="new-password"
            id="add-ghost-api-key"
            maxLength={GHOST_API_KEY_MAX_LENGTH}
            name="ghostApiKey"
            onChange={(event) => {
              setSecret(event.target.value);
              invalidateCheck();
            }}
            type="password"
            value={secret}
          />
          <p
            className="text-xs text-muted-foreground"
            id="add-ghost-api-key-hint"
          >
            {t("connectors.ghost.apiKeyHint")}
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          {t("connectors.ghost.contentNote")}
        </p>

        <div>
          <Button
            disabled={isChecking || isAdding || !hasCheckInputs}
            onClick={() => void handleCheck()}
            type="button"
            variant="outline"
          >
            {isChecking ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.ghost.dialog.checking")}
              </>
            ) : (
              t("connectors.ghost.dialog.check")
            )}
          </Button>
        </div>

        {result?.ready ? (
          <>
            <div className="flex items-start gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {t("connectors.ghost.dialog.reachable")}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {hostOf(trimmedUrl)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.ghost.dialog.reachableHint")}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="add-ghost-name">
                {t("connectors.ghost.nameLabel")}
              </Label>
              <Input
                autoComplete="off"
                id="add-ghost-name"
                maxLength={200}
                name="ghostName"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                checked={autoSync}
                className="mt-0.5"
                id="add-ghost-autosync"
                onCheckedChange={(value) => setAutoSync(value === true)}
              />
              <div className="space-y-0.5">
                <Label className="font-normal" htmlFor="add-ghost-autosync">
                  {t("connectors.ghost.dialog.autoSync")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.ghost.dialog.autoSyncHint")}
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
                {t("connectors.ghost.dialog.add")}
              </>
            ) : (
              t("connectors.ghost.dialog.add")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Presentational add dialog for a Ghost site (an `api_key` add mode): the API
 * URL and the Content API key from a custom integration in Ghost Admin, a
 * "Check connection" readiness check, then the name and schedule and create.
 * The parent supplies the check and create calls. The key lives only in this
 * component's local state and is cleared on submit, on failure and whenever
 * the dialog is reopened (a fresh form mounts per open); it is never rendered,
 * logged or placed in a cache, the URL or storage. The selection (content
 * types, tags, posts, pages) is chosen after the connector exists, through the
 * shared picker; only published content is read, and members-only and paid
 * posts are skipped.
 */
export function AddGhostDialog({
  open,
  onOpenChange,
  onCheck,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheck: (input: GhostCheckInput) => Promise<GhostCheckResult>;
  onAdd: (input: GhostAddInput) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        {/* Rendered inside the content so each open starts with a fresh form,
            and the key state is dropped when the dialog closes. */}
        <AddGhostForm
          onAdd={onAdd}
          onCheck={onCheck}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
