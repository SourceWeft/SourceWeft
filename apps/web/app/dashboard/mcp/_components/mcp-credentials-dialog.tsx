"use client";

import * as React from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { HttpClientError, type WorkspaceMcpInstall } from "@sourceweft/sdk";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@sourceweft/ui-web/components/ui/input-group";
import {
  RadioGroup,
  RadioGroupItem,
} from "@sourceweft/ui-web/components/ui/radio-group";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import {
  type McpAuthHeaderMethod,
  mcpAuthHeaderMethod,
  mcpAuthMethod,
} from "../../../../lib/mcp-auth-method";
import { contentClient } from "../../../../lib/sdk";

type ConnectionMethod = "oauth" | "header";

/**
 * The key header an install's manifest declares, when the dialog asks for that
 * one key instead of the install type's own form: an OAuth server that also
 * takes a key, an open server that takes one optionally, or a key server that
 * names its header. Custom-header installs and manifests without methods keep
 * the form for their auth type.
 */
function installKeyMethod(install: WorkspaceMcpInstall | null) {
  if (!install || install.authType === "custom_headers") return null;
  return mcpAuthHeaderMethod(install.manifestJson.auth);
}

function installAllowsOAuth(install: WorkspaceMcpInstall | null) {
  return Boolean(
    install?.manifestJson.auth.methods?.some(
      (method) => method.type === "oauth",
    ),
  );
}

export function parseCustomHeaders(
  value: string,
  messages?: { oneHeaderPerLine: string; nameAndValueRequired: string },
) {
  const headers: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(
        messages?.oneHeaderPerLine ??
          "Use one header per line, for example: X-API-Key: value",
      );
    }
    const name = line.slice(0, separatorIndex).trim();
    const headerValue = line.slice(separatorIndex + 1).trim();
    if (!name || !headerValue) {
      throw new Error(
        messages?.nameAndValueRequired ?? "Header name and value are required.",
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

export function CredentialsDialog({
  install,
  onClose,
  onSaved,
  open,
  workspaceId,
}: {
  install: WorkspaceMcpInstall | null;
  onClose: () => void;
  onSaved: (install: WorkspaceMcpInstall) => void;
  open: boolean;
  workspaceId: string | null;
}) {
  const t = useTranslations("dashboardMcpPanel");
  const tAuth = useTranslations("mcp.authMethod");
  const [bearerToken, setBearerToken] = React.useState("");
  const [apiKeyHeaderName, setApiKeyHeaderName] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [headersText, setHeadersText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [method, setMethod] = React.useState<ConnectionMethod>("oauth");
  const [key, setKey] = React.useState("");
  const [keyError, setKeyError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  const keyMethod = installKeyMethod(install);
  const allowsOAuth = Boolean(keyMethod) && installAllowsOAuth(install);
  const connectedVia = keyMethod ? (install?.connectedVia ?? null) : null;

  React.useEffect(() => {
    if (!install) return;
    setBearerToken("");
    setApiKey("");
    setApiKeyHeaderName(install.manifestJson.auth.headerName ?? "");
    setHeadersText("");
    setKey("");
    setKeyError(null);
    setFormError(null);
    // Open on how the member is connected now; OAuth first otherwise.
    setMethod(
      install.connectedVia ?? (installAllowsOAuth(install) ? "oauth" : "header"),
    );
  }, [install]);

  function chooseMethod(next: string) {
    setMethod(next === "header" ? "header" : "oauth");
    setKeyError(null);
    setFormError(null);
  }

  function saveErrorMessage(error: unknown) {
    if (
      error instanceof HttpClientError &&
      error.code === "MCP_CREDENTIAL_METHOD_NOT_ALLOWED"
    ) {
      return t("credentials.errors.methodNotAllowed");
    }
    return error instanceof Error && error.message
      ? error.message
      : t("credentials.toasts.saveFailed");
  }

  /** Save the one key for the manifest's header method. */
  async function saveKey() {
    if (!workspaceId || !install || !keyMethod) return;
    const bearer = keyMethod.scheme === "bearer";
    // "Bearer" is shown as a fixed prefix: drop it if it was pasted too.
    const secret = bearer
      ? key.trim().replace(/^bearer\s+/i, "")
      : key.trim();
    if (!secret) {
      setKeyError(t("credentials.errors.keyRequired"));
      return;
    }
    setKeyError(null);
    setFormError(null);
    setSaving(true);
    try {
      // The header name comes from the method, never from the member.
      const result = await contentClient.upsertWorkspaceMcpCredentials(
        workspaceId,
        install.id,
        bearer
          ? { authType: "bearer", bearerToken: secret }
          : {
              authType: "api_key_header",
              apiKeyHeaderName: keyMethod.name,
              apiKey: secret,
            },
      );
      toast.success(t("credentials.toasts.saved"));
      onSaved(result.install);
      onClose();
    } catch (error) {
      setFormError(saveErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveCredentials() {
    if (!workspaceId || !install) return;
    if (keyMethod) {
      await saveKey();
      return;
    }
    setSaving(true);
    try {
      const headerMessages = {
        oneHeaderPerLine: t("credentials.errors.oneHeaderPerLine"),
        nameAndValueRequired: t("credentials.errors.nameAndValueRequired"),
      };
      // Fail fast on a blank Save (the server rejects it too now): an empty
      // submission would otherwise clobber a previously configured credential.
      if (install.authType === "bearer" && !bearerToken.trim()) {
        toast.error(t("credentials.errors.bearerRequired"));
        return;
      }
      if (
        install.authType === "api_key_header" &&
        (!apiKeyHeaderName.trim() || !apiKey.trim())
      ) {
        toast.error(t("credentials.errors.apiKeyRequired"));
        return;
      }
      if (
        install.authType === "custom_headers" &&
        Object.keys(parseCustomHeaders(headersText, headerMessages)).length === 0
      ) {
        toast.error(t("credentials.errors.headerRequired"));
        return;
      }
      const input =
        install.authType === "bearer"
          ? {
              authType: "bearer" as const,
              bearerToken,
            }
          : install.authType === "api_key_header"
            ? {
                authType: "api_key_header" as const,
                apiKeyHeaderName,
                apiKey,
              }
            : install.authType === "custom_headers"
              ? {
                  authType: "custom_headers" as const,
                  headers: parseCustomHeaders(headersText, headerMessages),
                }
              : { authType: "none" as const };
      const result = await contentClient.upsertWorkspaceMcpCredentials(
        workspaceId,
        install.id,
        input,
      );
      toast.success(t("credentials.toasts.saved"));
      onSaved(result.install);
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("credentials.toasts.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function connectOAuth() {
    if (!workspaceId || !install) return;
    setSaving(true);
    try {
      const result = await contentClient.authorizeWorkspaceMcpOAuth(
        workspaceId,
        install.id,
      );
      if (result.status === "redirect") {
        // Hand off to the provider's consent screen; it redirects back to
        // /dashboard/mcp?mcpOAuth=connected. Keep the spinner during navigation.
        window.location.href = result.authorizationUrl;
        return;
      }
      toast.success(t("credentials.toasts.alreadyConnected"));
      // Reflect the connected state immediately: the pre-auth `install` still
      // carries credentialStatus "required", which would keep Run/selection
      // disabled until a full reload.
      onSaved({
        ...install,
        connectedVia: "oauth",
        credentialStatus: "configured",
      });
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("credentials.toasts.authStartFailed"),
      );
      setSaving(false);
    }
  }

  const authType = install?.authType ?? "none";
  const instructions = install?.manifestJson.auth.instructions;
  // Whether the OAuth sign-in is what the dialog offers right now.
  const oauthShown = keyMethod
    ? allowsOAuth && method === "oauth"
    : authType === "oauth";
  const switching =
    allowsOAuth && connectedVia !== null && connectedVia !== method;

  const oauthPanel = (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
      <p>{t("credentials.oauthNote")}</p>
      <Button
        disabled={saving || !install}
        onClick={() => void connectOAuth()}
        size="sm"
        type="button"
      >
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <KeyRound className="h-4 w-4" />
        )}
        {t("credentials.connect")}
      </Button>
    </div>
  );

  return (
    <Dialog onOpenChange={(nextOpen) => (!nextOpen ? onClose() : undefined)} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("credentials.title")}</DialogTitle>
          <DialogDescription>{t("credentials.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <div className="font-medium text-foreground">
              {install?.name ?? t("credentials.serverFallback")}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {keyMethod
                ? tAuth(mcpAuthMethod(install?.manifestJson.auth))
                : t(`credentials.authType.${authType}`)}
            </div>
            {connectedVia ? (
              <div className="mt-0.5 text-muted-foreground">
                {t(`credentials.connectedVia.${connectedVia}`)}
              </div>
            ) : null}
          </div>

          {instructions ? (
            <p className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
              {instructions}
            </p>
          ) : null}

          {keyMethod ? (
            <>
              {allowsOAuth ? (
                <RadioGroup
                  aria-label={t("credentials.method.label")}
                  className="grid gap-2 sm:grid-cols-2"
                  disabled={saving}
                  onValueChange={chooseMethod}
                  value={method}
                >
                  {(["oauth", "header"] as const).map((option) => (
                    <label
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-muted/40"
                      htmlFor={`mcp-method-${option}`}
                      key={option}
                    >
                      <RadioGroupItem id={`mcp-method-${option}`} value={option} />
                      {option === "oauth"
                        ? t("credentials.method.oauth")
                        : t("credentials.method.apiKey")}
                    </label>
                  ))}
                </RadioGroup>
              ) : null}

              {switching ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("credentials.method.switchNotice")}
                </p>
              ) : null}

              {oauthShown ? (
                oauthPanel
              ) : (
                <>
                  {authType === "none" ? (
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                      {t("credentials.optionalKeyNote")}
                    </div>
                  ) : null}
                  <HeaderKeyField
                    error={keyError}
                    method={keyMethod}
                    onChange={(value) => {
                      setKey(value);
                      setKeyError(null);
                    }}
                    optional={authType === "none"}
                    optionalLabel={t("credentials.method.optional")}
                    placeholder={t("credentials.placeholders.pasteKey")}
                    value={key}
                  />
                </>
              )}

              {formError ? (
                <p className="text-xs text-destructive" role="alert">
                  {formError}
                </p>
              ) : null}
            </>
          ) : null}

          {!keyMethod && authType === "bearer" ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="mcp-bearer">
                {t("credentials.fields.bearerToken")}
              </label>
              <Input
                autoComplete="off"
                id="mcp-bearer"
                onChange={(event) => setBearerToken(event.target.value)}
                placeholder={t("credentials.placeholders.pasteToken")}
                type="password"
                value={bearerToken}
              />
            </div>
          ) : null}

          {!keyMethod && authType === "api_key_header" ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_1fr]">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground" htmlFor="mcp-api-header">
                  {t("credentials.fields.headerName")}
                </label>
                <Input
                  autoComplete="off"
                  id="mcp-api-header"
                  onChange={(event) => setApiKeyHeaderName(event.target.value)}
                  placeholder="X-API-Key"
                  value={apiKeyHeaderName}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground" htmlFor="mcp-api-key">
                  {t("credentials.fields.apiKey")}
                </label>
                <Input
                  autoComplete="off"
                  id="mcp-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={t("credentials.placeholders.pasteKey")}
                  type="password"
                  value={apiKey}
                />
              </div>
            </div>
          ) : null}

          {!keyMethod && authType === "custom_headers" ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="mcp-custom-headers">
                {t("credentials.fields.headers")}
              </label>
              <Textarea
                className="min-h-28 font-mono text-xs"
                id="mcp-custom-headers"
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder={"X-API-Key: value\nX-Workspace: sourceweft"}
                value={headersText}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("credentials.headersHint")}
              </p>
            </div>
          ) : null}

          {!keyMethod && authType === "none" ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              {t("credentials.noAuthNote")}
            </div>
          ) : null}

          {!keyMethod && authType === "oauth" ? oauthPanel : null}
        </div>

        <DialogFooter>
          <Button disabled={saving} onClick={onClose} type="button" variant="outline">
            {oauthShown ? t("credentials.close") : t("credentials.cancel")}
          </Button>
          {oauthShown ? null : (
            <Button disabled={saving || !install} onClick={() => void saveCredentials()} type="button">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {t("credentials.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The one secret for a header method, labelled with the header it is sent in.
 * A bearer scheme shows "Bearer" as a fixed prefix, so only the key is typed.
 */
function HeaderKeyField({
  error,
  method,
  onChange,
  optional,
  optionalLabel,
  placeholder,
  value,
}: {
  error: string | null;
  method: McpAuthHeaderMethod;
  onChange: (value: string) => void;
  optional: boolean;
  optionalLabel: string;
  placeholder: string;
  value: string;
}) {
  const id = "mcp-header-key";
  const describedBy =
    [method.description ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const inputProps = {
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
    autoComplete: "off",
    id,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange(event.target.value),
    placeholder,
    type: "password",
    value,
  } as const;
  return (
    <div className="space-y-1.5">
      <label
        className="flex items-baseline gap-1.5 text-xs font-medium text-foreground"
        htmlFor={id}
      >
        <span className="break-all font-mono">{method.name}</span>
        {optional ? (
          <span className="font-normal text-muted-foreground">
            {optionalLabel}
          </span>
        ) : null}
      </label>
      {method.scheme === "bearer" ? (
        <InputGroup>
          <InputGroupAddon>
            <InputGroupText className="font-mono text-xs">Bearer</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput {...inputProps} />
        </InputGroup>
      ) : (
        <Input {...inputProps} />
      )}
      {method.description ? (
        <p className="text-[11px] leading-4 text-muted-foreground" id={`${id}-hint`}>
          {method.description}
        </p>
      ) : null}
      {error ? (
        <p className="text-[11px] text-destructive" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
