"use client";

import * as React from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { McpAuthType, WorkspaceMcpInstall } from "@sourceweft/sdk";
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

export function authTypeLabel(authType: McpAuthType) {
  if (authType === "bearer") return "Bearer token";
  if (authType === "api_key_header") return "API key header";
  if (authType === "custom_headers") return "Custom headers";
  if (authType === "oauth") return "OAuth";
  return "No auth";
}

export function parseCustomHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error("Use one header per line, for example: X-API-Key: value");
    }
    const name = line.slice(0, separatorIndex).trim();
    const headerValue = line.slice(separatorIndex + 1).trim();
    if (!name || !headerValue) {
      throw new Error("Header name and value are required.");
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
      // Fail fast on a blank Save (the server rejects it too now): an empty
      // submission would otherwise clobber a previously configured credential.
      if (install.authType === "bearer" && !bearerToken.trim()) {
        toast.error("Enter a bearer token before saving.");
        return;
      }
      if (
        install.authType === "api_key_header" &&
        (!apiKeyHeaderName.trim() || !apiKey.trim())
      ) {
        toast.error("Enter the header name and API key before saving.");
        return;
      }
      if (
        install.authType === "custom_headers" &&
        Object.keys(parseCustomHeaders(headersText)).length === 0
      ) {
        toast.error("Add at least one header before saving.");
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
                  headers: parseCustomHeaders(headersText),
                }
              : { authType: "none" as const };
      const result = await contentClient.upsertWorkspaceMcpCredentials(
        workspaceId,
        install.id,
        input,
      );
      toast.success("MCP credentials saved");
      onSaved(result.install);
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save credentials.",
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
      toast.success("MCP server already connected");
      // Reflect the connected state immediately: the pre-auth `install` still
      // carries credentialStatus "required", which would keep Run/selection
      // disabled until a full reload.
      onSaved({ ...install, credentialStatus: "configured" });
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start authorization.",
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
          <DialogTitle>Configure MCP credentials</DialogTitle>
          <DialogDescription>
            Credentials are encrypted in SourceWeft and sent only to this MCP
            server during tool calls.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <div className="font-medium text-foreground">
              {install?.name ?? "MCP server"}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {authTypeLabel(authType)}
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
                Bearer token
              </label>
              <Input
                autoComplete="off"
                id="mcp-bearer"
                onChange={(event) => setBearerToken(event.target.value)}
                placeholder="Paste token"
                type="password"
                value={bearerToken}
              />
            </div>
          ) : null}

          {authType === "api_key_header" ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_1fr]">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground" htmlFor="mcp-api-header">
                  Header name
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
                  API key
                </label>
                <Input
                  autoComplete="off"
                  id="mcp-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Paste key"
                  type="password"
                  value={apiKey}
                />
              </div>
            </div>
          ) : null}

          {authType === "custom_headers" ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="mcp-custom-headers">
                Headers
              </label>
              <Textarea
                className="min-h-28 font-mono text-xs"
                id="mcp-custom-headers"
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder={"X-API-Key: value\nX-Workspace: sourceweft"}
                value={headersText}
              />
              <p className="text-[11px] text-muted-foreground">
                Use one header per line. Secret values are not shown again after
                saving.
              </p>
            </div>
          ) : null}

          {authType === "none" ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              This MCP server does not require credentials.
            </div>
          ) : null}

          {authType === "oauth" ? (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              <p>
                This MCP server uses OAuth. Connect your account with the
                provider — you&apos;ll be redirected to grant access, then
                returned here. Your token is stored encrypted and refreshed
                automatically.
              </p>
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
                Connect
              </Button>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={saving} onClick={onClose} type="button" variant="outline">
            {authType === "oauth" ? "Close" : "Cancel"}
          </Button>
          {authType === "oauth" ? null : (
            <Button disabled={saving || !install} onClick={() => void saveCredentials()} type="button">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
