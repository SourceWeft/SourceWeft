"use client";

import * as React from "react";
import { KeyRound, Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  HttpClientError,
  type DiscoverWorkspaceMcpToolsResponse,
  type WorkspaceMcpInstall,
} from "@sourceweft/sdk";
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
import { acceptedMcpReturnTo } from "../../../../lib/mcp-return-to";
import { contentClient } from "../../../../lib/sdk";
import { catalogNoticeApplies } from "./mcp-catalog-notice";

type ConnectionMethod = "oauth" | "header";

/**
 * Where the connect flow is. `requesting`: asking the server for the provider's
 * authorization URL. `redirecting`: handing the browser to the provider.
 * `testing`: listing the tools this member can use with the new connection.
 * `result`: the outcome of that listing. Everything else is `idle`.
 */
type Phase = "idle" | "requesting" | "redirecting" | "testing" | "result";

// The server gives up on the provider after 20 s; these are a little longer so
// a server answer wins when there is one, and a dead connection still ends.
const AUTHORIZE_CLIENT_DEADLINE_MS = 30_000;
const DISCOVERY_CLIENT_DEADLINE_MS = 30_000;
// After the browser is told to leave, a page that is still here this long means
// the navigation was blocked or abandoned.
const REDIRECT_GUARD_MS = 15_000;
const TOOLS_SHOWN = 8;

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isWebUrl(url: string) {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function navigateTo(url: string) {
  window.location.assign(url);
}

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
  navigate = navigateTo,
  onClose,
  onSaved,
  onUseInChat,
  open,
  resumeConnected = false,
  returnTo,
  workspaceId,
}: {
  install: WorkspaceMcpInstall | null;
  /** Leaves the page for the provider; replaceable in tests. */
  navigate?: (url: string) => void;
  onClose: () => void;
  onSaved: (install: WorkspaceMcpInstall) => void;
  /** Opens a chat with this install selected, without sending anything. */
  onUseInChat?: (install: WorkspaceMcpInstall) => void;
  open: boolean;
  /**
   * The member has just come back from the provider connected: skip the
   * connect step and list their tools straight away.
   */
  resumeConnected?: boolean;
  /** The internal route the provider's redirect should return to. */
  returnTo?: string;
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
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [provider, setProvider] = React.useState("");
  const [discovery, setDiscovery] =
    React.useState<DiscoverWorkspaceMcpToolsResponse | null>(null);
  const [discoveryError, setDiscoveryError] = React.useState<string | null>(
    null,
  );
  // Each connect or listing run owns one attempt: cancelling, reopening or
  // leaving the dialog invalidates it, and a late response from an older
  // attempt is dropped instead of acted on.
  const attemptRef = React.useRef(0);
  const controllerRef = React.useRef<AbortController | null>(null);
  const timersRef = React.useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const busy = phase === "requesting" || phase === "redirecting" || phase === "testing";

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

  function clearTimers() {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.clear();
  }

  /** Invalidate whatever is running and return to idle. */
  const cancelAttempt = React.useCallback(() => {
    attemptRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.clear();
    setPhase("idle");
  }, []);

  function beginAttempt(deadlineMs: number, onDeadline: () => void) {
    cancelAttempt();
    const attempt = attemptRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      if (attempt !== attemptRef.current) return;
      // The deadline ends the attempt: the aborted request's own failure must
      // not overwrite the message the deadline shows.
      attemptRef.current += 1;
      controller.abort();
      onDeadline();
    }, deadlineMs);
    timersRef.current.add(timer);
    return { attempt, signal: controller.signal };
  }

  // A fresh dialog, whenever it opens, closes or switches install: nothing from
  // an earlier run survives, and a run that was in flight is dropped.
  React.useEffect(() => {
    cancelAttempt();
    setDiscovery(null);
    setDiscoveryError(null);
    setProvider("");
    return cancelAttempt;
  }, [cancelAttempt, install?.id, open]);

  // A page restored from the back/forward cache keeps its JavaScript state, so
  // a connect that had started would still show as pending, with its timers
  // still counting: end it.
  React.useEffect(() => {
    function onPageShow(event: Event) {
      if ((event as PageTransitionEvent).persisted) cancelAttempt();
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [cancelAttempt]);

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

  function failureMessage(error: unknown, fallback: string) {
    if (error instanceof HttpClientError) {
      if (error.code === "MCP_OAUTH_TIMEOUT") {
        return t("credentials.errors.authTimeout");
      }
      if (
        error.code === "MCP_OAUTH_NOT_CONNECTED" ||
        error.code === "MCP_NOT_CONNECTED"
      ) {
        return t("credentials.errors.notConnected");
      }
    }
    return error instanceof Error && error.message ? error.message : fallback;
  }

  /**
   * List the tools this member can use through their own connection. Nothing
   * is stored: the result is shown here and used for "Use in chat".
   */
  async function runDiscovery(target: WorkspaceMcpInstall | null = install) {
    if (!workspaceId || !target) return;
    const { attempt, signal } = beginAttempt(DISCOVERY_CLIENT_DEADLINE_MS, () => {
      setDiscoveryError(t("credentials.errors.discoveryTimeout"));
      setPhase("result");
    });
    setDiscovery(null);
    setDiscoveryError(null);
    setPhase("testing");
    try {
      const result = await contentClient.discoverWorkspaceMcpTools(
        workspaceId,
        target.id,
        { signal },
      );
      if (attempt !== attemptRef.current) return;
      clearTimers();
      setDiscovery(result);
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      clearTimers();
      setDiscoveryError(
        failureMessage(error, t("credentials.errors.discoveryFailed")),
      );
    }
    setPhase("result");
  }

  // Back from the provider already connected: go straight to the tool list.
  React.useEffect(() => {
    if (open && resumeConnected && install && workspaceId) {
      void runDiscovery(install);
    }
    // Only when the dialog is shown for this install; runDiscovery is stable
    // enough for that and re-running it on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resumeConnected, install?.id, workspaceId]);

  async function connectOAuth() {
    if (!workspaceId || !install) return;
    setFormError(null);
    const { attempt, signal } = beginAttempt(AUTHORIZE_CLIENT_DEADLINE_MS, () => {
      setFormError(t("credentials.errors.authTimeout"));
      setPhase("idle");
    });
    setPhase("requesting");
    try {
      const result = await contentClient.authorizeWorkspaceMcpOAuth(
        workspaceId,
        install.id,
        // A path the server would refuse (an identifier with a character
        // encodeURIComponent leaves alone) must not block Connect.
        { returnTo: acceptedMcpReturnTo(returnTo) ?? "/dashboard/mcp", signal },
      );
      // Cancelled, closed or timed out meanwhile: do nothing with the answer.
      if (attempt !== attemptRef.current) return;
      clearTimers();
      if (result.status === "redirect") {
        // Only a web address is ever navigated to.
        if (!isWebUrl(result.authorizationUrl)) {
          setFormError(t("credentials.toasts.authStartFailed"));
          setPhase("idle");
          return;
        }
        // Hand off to the provider's consent screen; the callback sends the
        // browser back to `returnTo`. If the page is still here shortly after,
        // the navigation was blocked or abandoned: say so instead of spinning.
        setProvider(hostOf(result.authorizationUrl));
        setPhase("redirecting");
        const guard = setTimeout(() => {
          timersRef.current.delete(guard);
          if (attempt !== attemptRef.current) return;
          setFormError(t("credentials.errors.redirectBlocked"));
          setPhase("idle");
        }, REDIRECT_GUARD_MS);
        timersRef.current.add(guard);
        navigate(result.authorizationUrl);
        return;
      }
      toast.success(t("credentials.toasts.alreadyConnected"));
      // Reflect the connected state immediately: the pre-auth `install` still
      // carries credentialStatus "required", which would keep Run/selection
      // disabled until a full reload.
      const connected = {
        ...install,
        connectedVia: "oauth" as const,
        credentialStatus: "configured" as const,
      };
      onSaved(connected);
      await runDiscovery(connected);
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      clearTimers();
      setFormError(failureMessage(error, t("credentials.toasts.authStartFailed")));
      setPhase("idle");
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
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || saving || !install}
          onClick={() => void connectOAuth()}
          size="sm"
          type="button"
        >
          {phase === "requesting" || phase === "redirecting" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          {t("credentials.connect")}
        </Button>
        {phase === "requesting" || phase === "redirecting" ? (
          <>
            <span aria-live="polite" role="status">
              {phase === "redirecting"
                ? t("credentials.states.redirecting", { provider })
                : t("credentials.states.requesting")}
            </span>
            <Button
              onClick={cancelAttempt}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("credentials.cancel")}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );

  const tools = discovery?.tools ?? [];
  const resultPanel =
    phase === "testing" || phase === "result" ? (
      <div
        aria-live="polite"
        className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs"
        role="status"
      >
        {phase === "testing" ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("credentials.states.testing")}
          </p>
        ) : discoveryError ? (
          <p className="text-destructive" role="alert">
            {discoveryError}
          </p>
        ) : discovery ? (
          <>
            <p className="font-medium text-foreground">
              {t("credentials.result.title", { count: discovery.toolCount })}
            </p>
            {tools.length > 0 ? (
              <ul className="space-y-1">
                {tools.slice(0, TOOLS_SHOWN).map((tool) => (
                  <li key={tool.name}>
                    <span className="font-mono text-foreground">{tool.name}</span>
                    {tool.description ? (
                      <span className="line-clamp-1 text-muted-foreground">
                        {tool.description}
                      </span>
                    ) : null}
                  </li>
                ))}
                {tools.length > TOOLS_SHOWN ? (
                  <li className="text-muted-foreground">
                    {t("credentials.result.more", {
                      count: tools.length - TOOLS_SHOWN,
                    })}
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                {t("credentials.result.empty")}
              </p>
            )}
            {discovery.truncated ? (
              <p className="text-muted-foreground">
                {t("credentials.result.truncated", { count: tools.length })}
              </p>
            ) : null}
            {discovery.skippedOversize > 0 ? (
              <p className="text-muted-foreground">
                {t("credentials.result.oversize", {
                  count: discovery.skippedOversize,
                })}
              </p>
            ) : null}
            <p className="text-muted-foreground">
              {t("credentials.result.private")}
            </p>
          </>
        ) : null}
      </div>
    ) : null;

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

          {resultPanel}

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
                  disabled={saving || busy}
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

          {catalogNoticeApplies(install, {
            declaredKeyMethod: Boolean(keyMethod),
            apiKeyHeaderName,
          }) ? (
            <p className="text-[11px] text-muted-foreground">
              {t("credentials.catalogNotice")}
            </p>
          ) : null}

          {formError ? (
            <p className="text-xs text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          {busy ? (
            <Button onClick={cancelAttempt} type="button" variant="outline">
              {t("credentials.cancel")}
            </Button>
          ) : (
            <Button disabled={saving} onClick={onClose} type="button" variant="outline">
              {oauthShown || phase === "result"
                ? t("credentials.close")
                : t("credentials.cancel")}
            </Button>
          )}
          {phase === "result" && discovery && onUseInChat && install ? (
            <Button onClick={() => onUseInChat(install)} type="button">
              <MessageSquare className="h-4 w-4" />
              {t("credentials.useInChat")}
            </Button>
          ) : phase === "result" && discoveryError ? (
            <Button onClick={() => void runDiscovery()} type="button">
              {t("credentials.retry")}
            </Button>
          ) : oauthShown ? null : (
            <Button disabled={saving || busy || !install} onClick={() => void saveCredentials()} type="button">
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
