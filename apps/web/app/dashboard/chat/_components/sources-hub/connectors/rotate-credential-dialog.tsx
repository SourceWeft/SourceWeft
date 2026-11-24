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

const USERNAME_MAX_LENGTH = 200;
const SECRET_MAX_LENGTH = 2000;

function isAcceptableUsername(value: string) {
  return (
    value.length > 0 &&
    value.length <= USERNAME_MAX_LENGTH &&
    !value.includes(":")
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
 * Presentational rotate dialog for a `credential` connector (WebDAV): it
 * replaces the stored username and app password in place, which is the
 * "reconnect" path for a credential connector whose account went
 * `reauth_required`. The app password lives only in local state and is cleared
 * on submit, on failure and when the dialog reopens; it is never rendered,
 * logged or placed in a cache, the URL or storage.
 */
export function RotateCredentialDialog({
  open,
  connectorName,
  initialUsername,
  onOpenChange,
  onRotate,
}: {
  open: boolean;
  connectorName: string;
  initialUsername: string | null;
  onOpenChange: (open: boolean) => void;
  onRotate: (input: { username: string; secret: string }) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        {/* Rendered inside the content so each open starts with a fresh form. */}
        <RotateCredentialForm
          connectorName={connectorName}
          initialUsername={initialUsername}
          onOpenChange={onOpenChange}
          onRotate={onRotate}
        />
      </DialogContent>
    </Dialog>
  );
}
