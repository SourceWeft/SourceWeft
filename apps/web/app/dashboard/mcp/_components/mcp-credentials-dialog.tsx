"use client";

import * as React from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { WorkspaceMcpInstall } from "@sourceweft/sdk";
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
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { contentClient } from "../../../../lib/sdk";

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
  const [bearerToken, setBearerToken] = React.useState("");
  const [apiKeyHeaderName, setApiKeyHeaderName] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [headersText, setHeadersText] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!install) return;
    setBearerToken("");
    setApiKey("");
    setApiKeyHeaderName(install.manifestJson.auth.headerName ?? "");
    setHeadersText("");
  }, [install]);

  async function saveCredentials() {
    if (!workspaceId || !install) return;
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
      onSaved({ ...install, credentialStatus: "configured" });
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
              {t(`credentials.authType.${authType}`)}
            </div>
          </div>

          {instructions ? (
            <p className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
              {instructions}
            </p>
          ) : null}

          {authType === "bearer" ? (
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

          {authType === "api_key_header" ? (
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

          {authType === "custom_headers" ? (
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

          {authType === "none" ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              {t("credentials.noAuthNote")}
            </div>
          ) : null}

          {authType === "oauth" ? (
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
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={saving} onClick={onClose} type="button" variant="outline">
            {authType === "oauth"
              ? t("credentials.close")
              : t("credentials.cancel")}
          </Button>
          {authType === "oauth" ? null : (
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
