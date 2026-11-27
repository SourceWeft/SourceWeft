import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

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
import {
  GHOST_API_KEY_MAX_LENGTH,
  GHOST_CONNECTOR_TYPE,
  GHOST_CREDENTIAL_USERNAME,
  isAcceptableGhostApiKey,
} from "./ghost-site-url";
import { WORDPRESS_LOGIN_CONNECTOR_TYPE } from "./wordpress-site-url";
import {
  isAcceptableZoteroApiKey,
  ZOTERO_API_KEY_MAX_LENGTH,
  ZOTERO_CONNECTOR_TYPE,
  zoteroLibraryRef,
} from "./zotero-library";

const USERNAME_MAX_LENGTH = 200;
const SECRET_MAX_LENGTH = 2000;

function isAcceptableUsername(value: string) {
  return (
    value.length > 0 &&
    value.length <= USERNAME_MAX_LENGTH &&
    !value.includes(":")
  );
}

/**
 * The Zotero rotate form: the credential username is the library reference
 * (`users/<id>` or `groups/<id>`), derived from the connector's own config, so
 * the member supplies the new API key only. The key lives only here and is
 * cleared on submit and on failure; it is never rendered.
 */
function RotateZoteroKeyForm({
  connectorName,
  configJson,
  onRotate,
  onOpenChange,
}: Pick<
  Parameters<typeof RotateCredentialDialog>[0],
  "connectorName" | "configJson" | "onRotate"
> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [secret, setSecret] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const libraryRef = zoteroLibraryRef(configJson ?? {});
  const canSave =
    libraryRef !== null && isAcceptableZoteroApiKey(secret) && !isSaving;

  async function handleRotate() {
    if (libraryRef === null || !isAcceptableZoteroApiKey(secret)) return;
    setRotateError(null);
    setIsSaving(true);
    try {
      await onRotate({ username: libraryRef, secret });
      setSecret("");
      onOpenChange(false);
    } catch (error) {
      setSecret("");
      setRotateError(
        getErrorMessage(error, t("connectors.zotero.rotate.failed")),
      );
    } finally {
      setIsSaving(false);
    }
  }

  const errorText =
    libraryRef === null
      ? t("connectors.zotero.rotate.libraryUnknown")
      : rotateError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.zotero.rotate.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.zotero.rotate.description", {
            name: connectorName,
            library: libraryRef ?? "",
          })}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void handleRotate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="rotate-zotero-api-key">
            {t("connectors.zotero.rotate.keyLabel")}
          </Label>
          <Input
            autoComplete="new-password"
            id="rotate-zotero-api-key"
            maxLength={ZOTERO_API_KEY_MAX_LENGTH}
            name="zoteroApiKey"
            onChange={(event) => {
              setSecret(event.target.value);
              setRotateError(null);
            }}
            type="password"
            value={secret}
          />
          <p className="text-xs text-muted-foreground">
            {t("connectors.zotero.apiKeyHint")}
          </p>
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
          <Button disabled={!canSave} type="submit">
            {isSaving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.zotero.rotate.save")}
              </>
            ) : (
              t("connectors.zotero.rotate.save")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * The Ghost rotate form: the Content API key only. Ghost has no username, so
 * the platform's required one is the fixed, non-secret placeholder; the
 * account identity is the site, which a new key never changes. The key lives
 * only here and is cleared on submit and on failure; it is never rendered.
 */
function RotateGhostKeyForm({
  connectorName,
  onRotate,
  onOpenChange,
}: Pick<
  Parameters<typeof RotateCredentialDialog>[0],
  "connectorName" | "onRotate"
> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [secret, setSecret] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const keyInvalid = secret !== "" && !isAcceptableGhostApiKey(secret);
  const canSave = secret !== "" && !keyInvalid && !isSaving;

  async function handleRotate() {
    if (!canSave) return;
    setRotateError(null);
    setIsSaving(true);
    try {
      await onRotate({ username: GHOST_CREDENTIAL_USERNAME, secret });
      setSecret("");
      onOpenChange(false);
    } catch (error) {
      setSecret("");
      setRotateError(
        getErrorMessage(error, t("connectors.ghost.rotate.failed")),
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.ghost.rotate.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.ghost.rotate.description", { name: connectorName })}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void handleRotate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="rotate-ghost-api-key">
            {t("connectors.ghost.rotate.keyLabel")}
          </Label>
          <Input
            aria-describedby="rotate-ghost-api-key-hint"
            aria-invalid={keyInvalid}
            autoComplete="new-password"
            id="rotate-ghost-api-key"
            maxLength={GHOST_API_KEY_MAX_LENGTH}
            name="ghostApiKey"
            onChange={(event) => {
              setSecret(event.target.value);
              setRotateError(null);
            }}
            type="password"
            value={secret}
          />
          <p
            className="text-xs text-muted-foreground"
            id="rotate-ghost-api-key-hint"
          >
            {t("connectors.ghost.rotate.keyHint")}
          </p>
        </div>

        {rotateError ? (
          <Alert variant="destructive">
            <AlertDescription>{rotateError}</AlertDescription>
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
          <Button disabled={!canSave} type="submit">
            {isSaving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.ghost.rotate.save")}
              </>
            ) : (
              t("connectors.ghost.rotate.save")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * The WordPress login rotate form: a username and a new Application Password.
 * The password lives only here and is cleared on submit and on failure; it is
 * never rendered, logged or placed in a URL. The hint says where to create a new
 * Application Password and that it can be revoked at any time.
 */
function RotateWordpressLoginForm({
  connectorName,
  initialUsername,
  onRotate,
  onOpenChange,
}: Pick<
  Parameters<typeof RotateCredentialDialog>[0],
  "connectorName" | "initialUsername" | "onRotate"
> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [username, setUsername] = useState(initialUsername ?? "");
  const [secret, setSecret] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const trimmedUsername = username.trim();
  const canSave =
    isAcceptableUsername(trimmedUsername) && secret.length > 0 && !isSaving;

  async function handleRotate() {
    if (!isAcceptableUsername(trimmedUsername)) {
      setFieldError(t("connectors.wordpress.dialog.invalidUsername"));
      return;
    }
    if (secret.length === 0 || secret.length > SECRET_MAX_LENGTH) {
      setFieldError(t("connectors.wordpress.dialog.passwordRequired"));
      return;
    }
    setFieldError(null);
    setRotateError(null);
    setIsSaving(true);
    try {
      await onRotate({ username: trimmedUsername, secret });
      setSecret("");
      onOpenChange(false);
    } catch (error) {
      setSecret("");
      setRotateError(
        getErrorMessage(error, t("connectors.wordpress.rotate.failed")),
      );
    } finally {
      setIsSaving(false);
    }
  }

  const errorText = fieldError ?? rotateError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.wordpress.rotate.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.wordpress.rotate.description", {
            name: connectorName,
          })}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void handleRotate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="rotate-wordpress-username">
            {t("connectors.wordpress.usernameLabel")}
          </Label>
          <Input
            autoComplete="off"
            id="rotate-wordpress-username"
            maxLength={USERNAME_MAX_LENGTH}
            name="wordpressUsername"
            onChange={(event) => {
              setUsername(event.target.value);
              setFieldError(null);
              setRotateError(null);
            }}
            value={username}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rotate-wordpress-password">
            {t("connectors.wordpress.passwordLabel")}
          </Label>
          <Input
            autoComplete="new-password"
            id="rotate-wordpress-password"
            maxLength={SECRET_MAX_LENGTH}
            name="wordpressPassword"
            onChange={(event) => {
              setSecret(event.target.value);
              setFieldError(null);
              setRotateError(null);
            }}
            type="password"
            value={secret}
          />
          <p className="text-xs text-muted-foreground">
            {t("connectors.wordpress.appPasswordHint")}
          </p>
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
          <Button disabled={!canSave} type="submit">
            {isSaving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.wordpress.rotate.save")}
              </>
            ) : (
              t("connectors.wordpress.rotate.save")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

function RotateCredentialForm({
  connectorName,
  initialUsername,
  onRotate,
  onOpenChange,
}: Pick<
  Parameters<typeof RotateCredentialDialog>[0],
  "connectorName" | "initialUsername" | "onRotate"
> & {
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dashboardSourcesHub");
  const [username, setUsername] = useState(initialUsername ?? "");
  // The app password lives only here and is cleared on submit, on failure and
  // when the dialog closes (a fresh form mounts per open). It never reaches a
  // query cache, the URL or storage.
  const [secret, setSecret] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const trimmedUsername = username.trim();
  const canSave =
    isAcceptableUsername(trimmedUsername) && secret.length > 0 && !isSaving;

  async function handleRotate() {
    if (!isAcceptableUsername(trimmedUsername)) {
      setFieldError(t("connectors.webdav.dialog.invalidUsername"));
      return;
    }
    if (secret.length === 0 || secret.length > SECRET_MAX_LENGTH) {
      setFieldError(t("connectors.webdav.dialog.passwordRequired"));
      return;
    }
    setFieldError(null);
    setRotateError(null);
    setIsSaving(true);
    try {
      await onRotate({ username: trimmedUsername, secret });
      setSecret("");
      onOpenChange(false);
    } catch (error) {
      setSecret("");
      setRotateError(
        getErrorMessage(error, t("connectors.webdav.rotate.failed")),
      );
    } finally {
      setIsSaving(false);
    }
  }

  const errorText = fieldError ?? rotateError;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connectors.webdav.rotate.title")}</DialogTitle>
        <DialogDescription>
          {t("connectors.webdav.rotate.description", { name: connectorName })}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void handleRotate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="rotate-webdav-username">
            {t("connectors.webdav.usernameLabel")}
          </Label>
          <Input
            autoComplete="off"
            id="rotate-webdav-username"
            maxLength={USERNAME_MAX_LENGTH}
            name="webdavUsername"
            onChange={(event) => {
              setUsername(event.target.value);
              setFieldError(null);
              setRotateError(null);
            }}
            value={username}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rotate-webdav-password">
            {t("connectors.webdav.passwordLabel")}
          </Label>
          <Input
            autoComplete="new-password"
            id="rotate-webdav-password"
            maxLength={SECRET_MAX_LENGTH}
            name="webdavPassword"
            onChange={(event) => {
              setSecret(event.target.value);
              setFieldError(null);
              setRotateError(null);
            }}
            type="password"
            value={secret}
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
          <Button disabled={!canSave} type="submit">
            {isSaving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {t("connectors.webdav.rotate.save")}
              </>
            ) : (
              t("connectors.webdav.rotate.save")
            )}
          </Button>
        </div>
      </form>
    </>
  );
}

/**
 * Presentational rotate dialog for a stored-credential connector: it replaces
 * the stored credential in place, which is the "reconnect" path for a
 * connector whose account went `reauth_required`. WebDAV asks for a username
 * and app password; WordPress (login) asks for a username and a new Application
 * Password; Zotero asks for the API key only and sends the library
 * reference derived from its config as the username; Ghost asks for the
 * Content API key only and sends a fixed placeholder username. The secret
 * lives only in local state and is cleared on submit, on failure and when the
 * dialog reopens; it is never rendered, logged or placed in a cache, the URL
 * or storage.
 */
export function RotateCredentialDialog({
  open,
  connectorName,
  connectorType,
  configJson,
  initialUsername,
  onOpenChange,
  onRotate,
}: {
  open: boolean;
  connectorName: string;
  /** The connector's type; omitted or anything other than `zotero`, `ghost`
   * or `wordpress_login` is the WebDAV username-and-password form. */
  connectorType?: string | null;
  /** The connector's stored config, read for Zotero's library reference. */
  configJson?: Record<string, unknown> | null;
  initialUsername: string | null;
  onOpenChange: (open: boolean) => void;
  onRotate: (input: { username: string; secret: string }) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        {/* Rendered inside the content so each open starts with a fresh form. */}
        {/* Dispatch is by connector type, with the WebDAV form as the implicit
            default: a further stored-credential connector needs its own entry
            here or a catalog field naming its form. */}
        {connectorType === GHOST_CONNECTOR_TYPE ? (
          <RotateGhostKeyForm
            connectorName={connectorName}
            onOpenChange={onOpenChange}
            onRotate={onRotate}
          />
        ) : connectorType === ZOTERO_CONNECTOR_TYPE ? (
          <RotateZoteroKeyForm
            configJson={configJson}
            connectorName={connectorName}
            onOpenChange={onOpenChange}
            onRotate={onRotate}
          />
        ) : connectorType === WORDPRESS_LOGIN_CONNECTOR_TYPE ? (
          <RotateWordpressLoginForm
            connectorName={connectorName}
            initialUsername={initialUsername}
            onOpenChange={onOpenChange}
            onRotate={onRotate}
          />
        ) : (
          <RotateCredentialForm
            connectorName={connectorName}
            initialUsername={initialUsername}
            onOpenChange={onOpenChange}
            onRotate={onRotate}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
