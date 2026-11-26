import { useRef, useState } from "react";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
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
import type {
  CredentialCheckResult,
  GenericCredentialAddInput,
  GenericCredentialCheckInput,
} from "./types";
import {
  isAcceptableZoteroApiKey,
  isAcceptableZoteroLibraryId,
  ZOTERO_API_KEY_MAX_LENGTH,
  ZOTERO_CONNECTOR_TYPE,
  ZOTERO_LIBRARY_ID_MAX_LENGTH,
  zoteroCredentialUsername,
  type ZoteroLibraryType,
} from "./zotero-library";

const DEFAULT_NAME = "Zotero";

/** Reasons the readiness check can report that have their own copy. */
const ZOTERO_READINESS_REASONS = [
  "reauth_required",
  "library_not_accessible",
  "library_not_found",
  "rate_limited",
  "unreachable",
  "blocked_endpoint",
  "config_invalid",
] as const;

type Checked = {
  libraryType: ZoteroLibraryType;
  libraryId: string;
  secret: string;
  result: CredentialCheckResult;
};

function AddApiKeyForm({
  onAdd,
  onCheck,
  onOpenChange,
}: Pick<Parameters<typeof AddApiKeyDialog>[0], "onAdd" | "onCheck"> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [libraryType, setLibraryType] = useState<ZoteroLibraryType>("user");
  const [libraryId, setLibraryId] = useState("");
  // The API key is held only here, in local component state, and is cleared
  // after any submit or failure (see below). It is never lifted into a query
  // cache, the URL or storage, and it is never rendered.
  const [secret, setSecret] = useState("");
  const [name, setName] = useState(DEFAULT_NAME);
  // Scheduled reconciliation is opt-in: the connector indexes once on create
  // and only keeps syncing on a schedule when the member asks.
  const [autoSync, setAutoSync] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  // Set synchronously on the first Add so a second click or submit in the same
  // tick cannot send another create before the disabled state renders.
  const addingRef = useRef(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Only the latest check may settle: an input edit or a newer check bumps it.
  const checkSeq = useRef(0);

  const trimmedId = libraryId.trim();
  // A check only counts for the exact inputs it ran with.
  const result =
    checked &&
    checked.libraryType === libraryType &&
    checked.libraryId === trimmedId &&
    checked.secret === secret
      ? checked.result
      : null;
  const hasCredential = trimmedId !== "" && secret !== "";
  const libraryIdInvalid =
    trimmedId !== "" && !isAcceptableZoteroLibraryId(trimmedId);
  const apiKeyInvalid = secret !== "" && !isAcceptableZoteroApiKey(secret);
  const canAdd = result?.ready === true && !isChecking && !isAdding;
  const notesMissing =
    result?.ready === true && result.metadata?.notesAccess === false;

  function invalidateCheck() {
    checkSeq.current += 1;
    setIsChecking(false);
    setFieldError(null);
    setCheckError(false);
    setAddError(null);
  }

  // Collections are chosen after the connector exists; an empty `items` list
  // indexes the whole library.
  function buildConfig(): Record<string, unknown> {
    return { libraryType, libraryId: trimmedId, items: [] };
  }

  async function handleCheck() {
    setAddError(null);
    setCheckError(false);
    if (!isAcceptableZoteroLibraryId(trimmedId)) {
      setFieldError(t("connectors.zotero.dialog.invalidLibraryId"));
      return;
    }
    if (!isAcceptableZoteroApiKey(secret)) {
      setFieldError(t("connectors.zotero.dialog.invalidApiKey"));
      return;
    }
    setFieldError(null);
    const seq = (checkSeq.current += 1);
    const checkedSecret = secret;
    setIsChecking(true);
    try {
      const next = await onCheck({
        connectorType: ZOTERO_CONNECTOR_TYPE,
        configJson: buildConfig(),
        credential: {
          username: zoteroCredentialUsername(libraryType, trimmedId),
          secret: checkedSecret,
        },
      });
      if (seq !== checkSeq.current) return;
      setChecked({
        libraryType,
        libraryId: trimmedId,
        secret: checkedSecret,
        result: next,
      });
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
      await onAdd({
        connectorType: ZOTERO_CONNECTOR_TYPE,
        name: name.trim() || DEFAULT_NAME,
        configJson: buildConfig(),
        credential: {
          username: zoteroCredentialUsername(libraryType, trimmedId),
          secret,
        },
        periodicIndexingEnabled: autoSync,
      });
      // The create succeeded; the dialog is closing, but drop the key from
      // state immediately so it never lingers after the submit.
      setSecret("");
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
        return t("connectors.zotero.dialog.credentialNotAllowed");
      }
      if (error.code === "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS") {
        return t("connectors.zotero.dialog.accountConflict");
      }
      if (error.code === "CONNECTOR_ALREADY_EXISTS") {
        return t("connectors.zotero.dialog.nameConflict");
      }
    }
    return getErrorMessage(error, t("connectors.zotero.dialog.addFailed"));
  }

  function readinessText(reason: string) {
    if ((ZOTERO_READINESS_REASONS as readonly string[]).includes(reason)) {
      return t(`connectors.zotero.readiness.${reason}`);
    }
    return t("connectors.readinessNotReady");
  }

  const errorText = fieldError
    ? fieldError
    : checkError
      ? t("connectors.zotero.dialog.checkFailed")
      : result && !result.ready
        ? readinessText(result.reason)
        : addError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.zotero.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.zotero.dialog.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canAdd) void handleAdd();
          else if (!isChecking && hasCredential) void handleCheck();
        }}
      >
        <div className="space-y-1.5">
          <Label id="add-zotero-type-label">
            {t("connectors.zotero.libraryTypeLabel")}
          </Label>
          <RadioGroup
            aria-labelledby="add-zotero-type-label"
            className="grid gap-2 sm:grid-cols-2"
            onValueChange={(value) => {
              setLibraryType(value === "group" ? "group" : "user");
              invalidateCheck();
            }}
            value={libraryType}
          >
            {(["user", "group"] as const).map((option) => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/40"
                htmlFor={`add-zotero-type-${option}`}
                key={option}
              >
                <RadioGroupItem
                  id={`add-zotero-type-${option}`}
                  value={option}
                />
                {option === "user"
                  ? t("connectors.zotero.libraryTypePersonal")
                  : t("connectors.zotero.libraryTypeGroup")}
              </label>
            ))}
          </RadioGroup>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="add-zotero-library-id">
            {t("connectors.zotero.libraryIdLabel")}
          </Label>
          <Input
            aria-describedby="add-zotero-library-id-hint"
            aria-invalid={libraryIdInvalid}
            autoComplete="off"
            id="add-zotero-library-id"
            inputMode="numeric"
            maxLength={ZOTERO_LIBRARY_ID_MAX_LENGTH}
            name="zoteroLibraryId"
            onChange={(event) => {
              setLibraryId(event.target.value);
              invalidateCheck();
            }}
            value={libraryId}
          />
          <p
            className="text-xs text-muted-foreground"
            id="add-zotero-library-id-hint"
          >
            {libraryType === "user"
              ? t("connectors.zotero.libraryIdHintPersonal")
              : t("connectors.zotero.libraryIdHintGroup")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="add-zotero-api-key">
            {t("connectors.zotero.apiKeyLabel")}
          </Label>
          <Input
            aria-describedby="add-zotero-api-key-hint"
            aria-invalid={apiKeyInvalid}
            autoComplete="new-password"
            id="add-zotero-api-key"
            maxLength={ZOTERO_API_KEY_MAX_LENGTH}
            name="zoteroApiKey"
            onChange={(event) => {
              setSecret(event.target.value);
              invalidateCheck();
            }}
            type="password"
            value={secret}
          />
          <p
            className="text-xs text-muted-foreground"
            id="add-zotero-api-key-hint"
          >
            {t("connectors.zotero.apiKeyHint")}
          </p>
        </div>

        <div>
          <Button
            disabled={isChecking || isAdding || !hasCredential}
            onClick={() => void handleCheck()}
            type="button"
            variant="outline"
          >
            {isChecking ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.zotero.dialog.checking")}
              </>
            ) : (
              t("connectors.zotero.dialog.check")
            )}
          </Button>
        </div>

        {result?.ready ? (
          <>
            <div className="flex items-start gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {t("connectors.zotero.dialog.connected")}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {zoteroCredentialUsername(libraryType, trimmedId)}
                </p>
              </div>
            </div>

            {notesMissing ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p>{t("connectors.zotero.dialog.notesAccessWarning")}</p>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="add-zotero-name">
                {t("connectors.zotero.nameLabel")}
              </Label>
              <Input
                autoComplete="off"
                id="add-zotero-name"
                maxLength={200}
                name="zoteroName"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                checked={autoSync}
                className="mt-0.5"
                id="add-zotero-autosync"
                onCheckedChange={(value) => setAutoSync(value === true)}
              />
              <div className="space-y-0.5">
                <Label className="font-normal" htmlFor="add-zotero-autosync">
                  {t("connectors.zotero.dialog.autoSync")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("connectors.zotero.dialog.autoSyncHint")}
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
                {t("connectors.zotero.dialog.add")}
              </>
            ) : (
              t("connectors.zotero.dialog.add")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Presentational add dialog for an `api_key` connector (Zotero): library type
 * and ID plus a read-only API key, then a "Check key" readiness check, then
 * the name and schedule and create. The parent supplies the check and create
 * calls. The key lives only in this component's local state and is cleared on
 * submit, on failure and whenever the dialog is reopened (a fresh form mounts
 * per open); it is never rendered, logged or placed in a cache, the URL or
 * storage. Collections are chosen after the connector exists, through the
 * shared selection picker; until then the whole library is indexed.
 */
export function AddApiKeyDialog({
  open,
  onOpenChange,
  onCheck,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheck: (
    input: GenericCredentialCheckInput,
  ) => Promise<CredentialCheckResult>;
  onAdd: (input: GenericCredentialAddInput) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        {/* Rendered inside the content so each open starts with a fresh form,
            and the API key state is dropped when the dialog closes. */}
        <AddApiKeyForm
          onAdd={onAdd}
          onCheck={onCheck}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
