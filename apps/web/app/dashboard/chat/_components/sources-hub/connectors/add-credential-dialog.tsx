import { useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

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
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";

import { getErrorMessage } from "../lib/errors";
import type { CredentialCheckResult } from "./types";
import { parseWebdavRootsInput } from "./webdav-roots";

const ENDPOINT_MAX_LENGTH = 2048;
const USERNAME_MAX_LENGTH = 200;
const SECRET_MAX_LENGTH = 2000;

/** Reasons the readiness check can report that have their own copy. The
 * endpoint add check runs against the whole-endpoint root, so the path reasons
 * are rare but still mapped. */
const WEBDAV_READINESS_REASONS = [
  "reauth_required",
  "blocked_endpoint",
  "unreachable",
  "config_invalid",
  "path_forbidden",
  "path_not_found",
] as const;

/** The same rules the server applies: http(s) only, no `user:pass@`, no query
 * or fragment. https vs http is left to the deployment allowlist. */
function isAcceptableEndpoint(value: string) {
  if (value.length === 0 || value.length > ENDPOINT_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/** A username the server would accept: 1..200 after trimming and no colon (a
 * colon is the Basic-auth separator). */
function isAcceptableUsername(value: string) {
  return value.length > 0 && value.length <= USERNAME_MAX_LENGTH
    && !value.includes(":");
}

function hostOf(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
}

type Checked = {
  endpoint: string;
  username: string;
  secret: string;
  result: CredentialCheckResult;
};

function AddCredentialForm({
  onAdd,
  onCheck,
  onOpenChange,
}: Pick<Parameters<typeof AddCredentialDialog>[0], "onAdd" | "onCheck"> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  // The app password is held only here, in local component state, and is
  // cleared after any submit or failure (see below). It is never lifted into a
  // query cache, the URL or storage.
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [roots, setRoots] = useState("/");
  const [isChecking, setIsChecking] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // Only the latest check may settle: an input edit or a newer check bumps it.
  const checkSeq = useRef(0);

  const trimmedEndpoint = endpoint.trim();
  const trimmedUsername = username.trim();
  const trimmedName = name.trim();
  const result =
    checked &&
    checked.endpoint === trimmedEndpoint &&
    checked.username === trimmedUsername &&
    checked.secret === secret
      ? checked.result
      : null;
  const hasCredential =
    trimmedEndpoint !== "" && trimmedUsername !== "" && secret !== "";
  const canAdd = result?.ready === true && !isChecking && !isAdding;

  function invalidateCheck() {
    checkSeq.current += 1;
    setIsChecking(false);
    setFieldError(null);
    setCheckError(false);
    setAddError(null);
  }

  async function handleCheck() {
    setAddError(null);
    setCheckError(false);
    if (!isAcceptableEndpoint(trimmedEndpoint)) {
      setFieldError(t("connectors.webdav.dialog.invalidEndpoint"));
      return;
    }
    if (!isAcceptableUsername(trimmedUsername)) {
      setFieldError(t("connectors.webdav.dialog.invalidUsername"));
      return;
    }
    if (secret.length === 0 || secret.length > SECRET_MAX_LENGTH) {
      setFieldError(t("connectors.webdav.dialog.passwordRequired"));
      return;
    }
    setFieldError(null);
    const seq = (checkSeq.current += 1);
    const checkedSecret = secret;
    setIsChecking(true);
    try {
      const next = await onCheck({
        endpoint: trimmedEndpoint,
        username: trimmedUsername,
        secret: checkedSecret,
      });
      if (seq !== checkSeq.current) return;
      setChecked({
        endpoint: trimmedEndpoint,
        username: trimmedUsername,
        secret: checkedSecret,
        result: next,
      });
      if (!name) setName(hostOf(trimmedEndpoint));
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
    const parsedRoots = parseWebdavRootsInput(roots);
    if (!parsedRoots.ok) {
      setAddError(
        t(
          parsedRoots.reason === "limit"
            ? "connectors.webdav.dialog.rootsLimit"
            : "connectors.webdav.dialog.invalidRoots",
        ),
      );
      return;
    }
    setAddError(null);
    setIsAdding(true);
    try {
      await onAdd({
        name: trimmedName || hostOf(trimmedEndpoint),
        endpoint: trimmedEndpoint,
        username: trimmedUsername,
        secret,
        roots: parsedRoots.roots,
      });
      // The create succeeded; the dialog is closing, but drop the secret from
      // state immediately so it never lingers after the submit.
      setSecret("");
      onOpenChange(false);
    } catch (error) {
      // The create failed with the secret already in flight: clear it so a
      // retry re-enters it deliberately and nothing is retained after a failure.
      setSecret("");
      setChecked(null);
      setAddError(addFailureText(error));
    } finally {
      setIsAdding(false);
    }
  }

  function addFailureText(error: unknown): string {
    if (error instanceof HttpClientError) {
      if (error.code === "CONNECTOR_CREDENTIAL_NOT_ALLOWED") {
        return t("connectors.webdav.dialog.credentialNotAllowed");
      }
      if (error.code === "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS") {
        return t("connectors.webdav.dialog.accountConflict");
      }
      if (error.code === "CONNECTOR_ALREADY_EXISTS") {
        return t("connectors.webdav.dialog.nameConflict");
      }
    }
    return getErrorMessage(error, t("connectors.webdav.dialog.addFailed"));
  }

  function readinessText(reason: string) {
    if ((WEBDAV_READINESS_REASONS as readonly string[]).includes(reason)) {
      return t(`connectors.webdav.readiness.${reason}`);
    }
    return t("connectors.readinessNotReady");
  }

  const errorText = fieldError
    ? fieldError
    : checkError
      ? t("connectors.webdav.dialog.checkFailed")
      : result && !result.ready
        ? readinessText(result.reason)
        : addError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.webdav.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.webdav.dialog.description")}
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
          <Label htmlFor="add-webdav-endpoint">
            {t("connectors.webdav.endpointLabel")}
          </Label>
          <Input
            autoComplete="off"
            id="add-webdav-endpoint"
            name="webdavEndpoint"
            onChange={(event) => {
              setEndpoint(event.target.value);
              invalidateCheck();
            }}
            placeholder="https://cloud.example.com/remote.php/dav/files/alice"
            type="url"
            value={endpoint}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="add-webdav-username">
              {t("connectors.webdav.usernameLabel")}
            </Label>
            <Input
              autoComplete="off"
              id="add-webdav-username"
              maxLength={USERNAME_MAX_LENGTH}
              name="webdavUsername"
              onChange={(event) => {
                setUsername(event.target.value);
                invalidateCheck();
              }}
              value={username}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-webdav-password">
              {t("connectors.webdav.passwordLabel")}
            </Label>
            <Input
              autoComplete="new-password"
              id="add-webdav-password"
              maxLength={SECRET_MAX_LENGTH}
              name="webdavPassword"
              onChange={(event) => {
                setSecret(event.target.value);
                invalidateCheck();
              }}
              type="password"
              value={secret}
            />
          </div>
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
                {t("connectors.webdav.dialog.checking")}
              </>
            ) : (
              t("connectors.webdav.dialog.check")
            )}
          </Button>
        </div>

        {result?.ready ? (
          <>
            <div className="flex items-start gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {t("connectors.webdav.dialog.connected")}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {hostOf(trimmedEndpoint)}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="add-webdav-name">
                {t("connectors.webdav.nameLabel")}
              </Label>
              <Input
                autoComplete="off"
                id="add-webdav-name"
                maxLength={200}
                name="webdavName"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="add-webdav-roots">
                {t("connectors.webdav.foldersLabel")}
              </Label>
              <Textarea
                autoComplete="off"
                className="font-mono text-xs"
                id="add-webdav-roots"
                name="webdavRoots"
                onChange={(event) => {
                  setRoots(event.target.value);
                  setAddError(null);
                }}
                rows={3}
                value={roots}
              />
              <p className="text-xs text-muted-foreground">
                {t("connectors.webdav.foldersHint")}
              </p>
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
                {t("connectors.webdav.dialog.add")}
              </>
            ) : (
              t("connectors.webdav.dialog.add")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Presentational add dialog for a `credential` connector (WebDAV): endpoint,
 * username and app password, then a "Test connection" readiness check, then the
 * folders to index and create. The parent supplies the check and create calls.
 * The app password lives only in this component's local state and is cleared on
 * submit, on failure and whenever the dialog is reopened (a fresh form mounts
 * per open); it is never rendered, logged or placed in a cache, the URL or
 * storage.
 */
export function AddCredentialDialog({
  open,
  onOpenChange,
  onCheck,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheck: (input: {
    endpoint: string;
    username: string;
    secret: string;
  }) => Promise<CredentialCheckResult>;
  onAdd: (input: {
    name: string;
    endpoint: string;
    username: string;
    secret: string;
    roots: string[];
  }) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        {/* Rendered inside the content so each open starts with a fresh form,
            and the app password state is dropped when the dialog closes. */}
        <AddCredentialForm
          onAdd={onAdd}
          onCheck={onCheck}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
