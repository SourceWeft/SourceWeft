import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  HttpClientError,
  type PollCredentialFlowResponse,
  type SourceConnector,
} from "@sourceweft/sdk";
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
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";

import { parseWebdavRootsInput } from "./webdav-roots";

const SERVER_URL_MAX_LENGTH = 2048;
/** One upstream approval poll every two seconds (set-timeout chain, never
 * overlapping). */
const POLL_INTERVAL_MS = 2000;
/** Give up after ten minutes — the backend flow expires at the same point. */
const MAX_WAIT_MS = 10 * 60 * 1000;

/** Start-request shape the dialog collects; `connectorId` for a reconnect is
 * injected by the parent closure, so the dialog never handles it. */
export type LoginFlowStartInput = {
  serverUrl: string;
  name: string;
  roots?: string[];
  periodicIndexingEnabled?: boolean;
};

export type LoginFlowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add mode when null; a reconnect supplies the fixed server and connector
   * name, and the start is run straight away with no form and no password. */
  reconnect: { connectorName: string; serverUrl: string } | null;
  onStart: (input: LoginFlowStartInput) => Promise<{
    flowId: string;
    loginUrl: string;
  }>;
  onPoll: (flowId: string) => Promise<PollCredentialFlowResponse>;
  /** Best-effort cancel of the server-side flow; the dialog never blocks on it. */
  onCancel: (flowId: string) => Promise<unknown>;
  onConnected: (connector: SourceConnector) => void;
};

/** The same server rules the backend applies: http(s) only, no `user:pass@`, no
 * query or fragment. A base path (sub-folder install) is allowed. */
function isAcceptableServerUrl(value: string) {
  if (value.length === 0 || value.length > SERVER_URL_MAX_LENGTH) return false;
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

function hostOf(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

/**
 * Re-validate a URL before it is ever handed to `window.open`. The login URL
 * comes from the member's own Nextcloud server and the SDK does not runtime-check
 * the response, so the contract's http(s) refine is enforced only server-side: a
 * malicious server could return `javascript:` or `data:`. Accept only http/https
 * with no embedded userinfo and return the normalised href; reject anything else.
 */
function parseHttpUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.href;
}

/** Fixed-message mapping for every documented flow failure; every branch is a
 * static localized string and never echoes any input. */
function loginFlowErrorText(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
): string {
  if (error instanceof HttpClientError) {
    switch (error.code) {
      case "NEXTCLOUD_UNREACHABLE":
        return t("connectors.nextcloud.errors.unreachable");
      case "NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED":
        return t("connectors.nextcloud.errors.notNextcloud");
      case "NEXTCLOUD_LOGIN_FLOW_INVALID":
        return t("connectors.nextcloud.errors.invalidResponse");
      case "NEXTCLOUD_BLOCKED_ENDPOINT":
        return t("connectors.nextcloud.errors.blockedAddress");
      case "CONNECTOR_CREDENTIAL_FLOW_UNSUPPORTED":
        return t("connectors.nextcloud.errors.notSupported");
      case "CONNECTOR_CREDENTIAL_FLOW_LIMIT":
        return t("connectors.nextcloud.errors.tooManyFlows");
      case "CONNECTOR_CREDENTIAL_FLOW_MISMATCH":
        return t("connectors.nextcloud.errors.reconnectMismatch");
      case "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS":
      case "CONNECTOR_ALREADY_EXISTS":
        return t("connectors.nextcloud.errors.alreadyConnected");
      case "CONNECTOR_CREDENTIAL_NOT_ALLOWED":
        return t("connectors.nextcloud.errors.notAllowed");
      case "CONNECTOR_CONFIG_NOT_READY":
        return configNotReadyText(error, t);
      default:
        return t("connectors.nextcloud.errors.failed");
    }
  }
  return t("connectors.nextcloud.errors.failed");
}

/** A readiness refusal carries the reason in `details.reason`; map the ones a
 * Nextcloud connector can report (none signs the member out). */
function configNotReadyText(
  error: HttpClientError,
  t: ReturnType<typeof useTranslations>,
): string {
  const reason = error.details?.reason;
  switch (reason) {
    case "not_nextcloud":
      return t("connectors.nextcloud.errors.notNextcloud");
    case "reauth_required":
      return t("connectors.nextcloud.errors.permissionLost");
    case "path_not_found":
      return t("connectors.nextcloud.errors.pathNotFound");
    case "path_forbidden":
      return t("connectors.nextcloud.errors.pathForbidden");
    default:
      return t("connectors.nextcloud.errors.notReady");
  }
}

type Phase = "form" | "connecting" | "waiting" | "failed";

function LoginFlowBody({
  reconnect,
  onOpenChange,
  onStart,
  onPoll,
  onCancel,
  onConnected,
}: Omit<LoginFlowDialogProps, "open">) {
  const t = useTranslations("dashboardSourcesHub");
  const [serverUrl, setServerUrl] = useState(reconnect?.serverUrl ?? "");
  const [name, setName] = useState(reconnect?.connectorName ?? "");
  const [roots, setRoots] = useState("/");
  // Scheduled reconciliation is opt-in: index once on connect, keep syncing on
  // a schedule only when the member asks.
  const [autoSync, setAutoSync] = useState(false);
  const [phase, setPhase] = useState<Phase>(reconnect ? "connecting" : "form");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // The login URL and flow id live only in component state/refs: never a URL,
  // storage, query cache key, analytics event or log line.
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const activeRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const flowIdRef = useRef<string | null>(null);
  const loginUrlRef = useRef<string | null>(null);

  function stopPolling() {
    activeRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  // Open the login URL only after re-validating it as an http(s) URL; returns
  // the normalised href that was opened, or null when the URL was refused (and
  // nothing was opened).
  function openLogin(url: string): string | null {
    const safe = parseHttpUrl(url);
    if (!safe) return null;
    window.open(safe, "_blank", "noopener,noreferrer");
    return safe;
  }

  function scheduleNextPoll() {
    timerRef.current = window.setTimeout(() => {
      void runPoll();
    }, POLL_INTERVAL_MS);
  }

  async function runPoll() {
    if (!activeRef.current) return;
    if (Date.now() - startedAtRef.current >= MAX_WAIT_MS) {
      stopPolling();
      setPhase("failed");
      setErrorText(t("connectors.nextcloud.errors.timedOut"));
      return;
    }
    const flowId = flowIdRef.current;
    if (!flowId) return;
    try {
      const result = await onPoll(flowId);
      if (!activeRef.current || !mountedRef.current) return;
      if (result.status === "pending") {
        scheduleNextPoll();
        return;
      }
      if (result.status === "expired") {
        stopPolling();
        setPhase("failed");
        setErrorText(t("connectors.nextcloud.errors.expired"));
        return;
      }
      // Connected: the backend created or rotated the connector during the poll.
      stopPolling();
      onConnected(result.connector);
      onOpenChange(false);
    } catch (error) {
      if (!activeRef.current || !mountedRef.current) return;
      stopPolling();
      setPhase("failed");
      setErrorText(loginFlowErrorText(error, t));
    }
  }

  async function beginFlow(input: LoginFlowStartInput) {
    setFieldError(null);
    setErrorText(null);
    setPhase("connecting");
    let started: { flowId: string; loginUrl: string };
    try {
      started = await onStart(input);
    } catch (error) {
      if (!mountedRef.current) return;
      // The add-mode form fields stay in state, so "Try again" returns to the
      // form with them intact; a reconnect restarts the same flow.
      setPhase("failed");
      setErrorText(loginFlowErrorText(error, t));
      return;
    }
    if (!mountedRef.current) return;
    // Open the provider login in the click handler's own continuation, right
    // after the start response, so a popup blocker is less likely to refuse it;
    // the waiting state also shows a visible "open again" link as the fallback.
    // The URL is re-validated here (not just server-side): a non-http(s) loginUrl
    // is never opened — abort the flow and best-effort cancel it on the backend.
    const safeLoginUrl = openLogin(started.loginUrl);
    if (!safeLoginUrl) {
      if (started.flowId) void onCancel(started.flowId);
      setPhase("failed");
      setErrorText(t("connectors.nextcloud.errors.failed"));
      return;
    }
    loginUrlRef.current = safeLoginUrl;
    setLoginUrl(safeLoginUrl);
    flowIdRef.current = started.flowId;
    startedAtRef.current = Date.now();
    activeRef.current = true;
    setPhase("waiting");
    scheduleNextPoll();
  }

  function handleConnect() {
    const trimmedServer = serverUrl.trim();
    if (!isAcceptableServerUrl(trimmedServer)) {
      setFieldError(t("connectors.nextcloud.dialog.invalidServer"));
      return;
    }
    const parsedRoots = parseWebdavRootsInput(roots);
    if (!parsedRoots.ok) {
      setFieldError(
        t(
          parsedRoots.reason === "limit"
            ? "connectors.nextcloud.dialog.rootsLimit"
            : "connectors.nextcloud.dialog.invalidRoots",
        ),
      );
      return;
    }
    void beginFlow({
      serverUrl: trimmedServer,
      name: name.trim() || hostOf(trimmedServer),
      roots: parsedRoots.roots,
      periodicIndexingEnabled: autoSync,
    });
  }

  function handleRetry() {
    if (reconnect) {
      void beginFlow({
        serverUrl: reconnect.serverUrl,
        name: reconnect.connectorName,
      });
      return;
    }
    setErrorText(null);
    setPhase("form");
  }

  function handleCancelWaiting() {
    stopPolling();
    const flowId = flowIdRef.current;
    if (flowId) void onCancel(flowId);
    onOpenChange(false);
  }

  // Reconnect runs the same flow straight away (no form, no password); the
  // server and name come from the connector being reconnected.
  useEffect(() => {
    mountedRef.current = true;
    if (reconnect) {
      void beginFlow({
        serverUrl: reconnect.serverUrl,
        name: reconnect.connectorName,
      });
    }
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
    // Run once per mount; `beginFlow` and `reconnect` are stable for a given open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = reconnect
    ? t("connectors.nextcloud.reconnect.title")
    : t("connectors.nextcloud.dialog.title");
  const description = reconnect
    ? t("connectors.nextcloud.reconnect.description", {
        name: reconnect.connectorName,
      })
    : t("connectors.nextcloud.dialog.description");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      {phase === "form" ? (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleConnect();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="add-nextcloud-server">
              {t("connectors.nextcloud.serverLabel")}
            </Label>
            <Input
              autoComplete="off"
              id="add-nextcloud-server"
              name="nextcloudServer"
              onChange={(event) => {
                setServerUrl(event.target.value);
                setFieldError(null);
              }}
              placeholder="https://cloud.example.com"
              type="url"
              value={serverUrl}
            />
            <p className="text-xs text-muted-foreground">
              {t("connectors.nextcloud.serverHint")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-nextcloud-name">
              {t("connectors.nextcloud.nameLabel")}
            </Label>
            <Input
              autoComplete="off"
              id="add-nextcloud-name"
              maxLength={200}
              name="nextcloudName"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-nextcloud-roots">
              {t("connectors.nextcloud.foldersLabel")}
            </Label>
            <Textarea
              autoComplete="off"
              className="font-mono text-xs"
              id="add-nextcloud-roots"
              name="nextcloudRoots"
              onChange={(event) => {
                setRoots(event.target.value);
                setFieldError(null);
              }}
              rows={3}
              value={roots}
            />
            <p className="text-xs text-muted-foreground">
              {t("connectors.nextcloud.foldersHint")}
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              checked={autoSync}
              className="mt-0.5"
              id="add-nextcloud-autosync"
              onCheckedChange={(value) => setAutoSync(value === true)}
            />
            <div className="space-y-0.5">
              <Label className="font-normal" htmlFor="add-nextcloud-autosync">
                {t("connectors.nextcloud.dialog.autoSync")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("connectors.nextcloud.dialog.autoSyncHint")}
              </p>
            </div>
          </div>

          {fieldError ? (
            <Alert variant="destructive">
              <AlertDescription>{fieldError}</AlertDescription>
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
            <Button type="submit">
              {t("connectors.nextcloud.dialog.connect")}
            </Button>
          </div>
        </form>
      ) : null}

      {phase === "connecting" ? (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <span>{t("connectors.nextcloud.dialog.connecting")}</span>
        </div>
      ) : null}

      {phase === "waiting" ? (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border bg-muted/35 p-3 text-sm">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {t("connectors.nextcloud.dialog.waitingTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("connectors.nextcloud.dialog.waitingDescription")}
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            {loginUrl ? (
              <Button
                onClick={() => {
                  // Defensive: `loginUrl` is already a validated href, but
                  // re-validate so nothing but an http(s) URL ever reaches the
                  // browser.
                  if (!openLogin(loginUrl)) {
                    stopPolling();
                    setPhase("failed");
                    setErrorText(t("connectors.nextcloud.errors.failed"));
                  }
                }}
                type="button"
                variant="outline"
              >
                <ExternalLink className="size-3.5" />
                {t("connectors.nextcloud.dialog.openAgain")}
              </Button>
            ) : (
              <span />
            )}
            <Button
              onClick={handleCancelWaiting}
              type="button"
              variant="ghost"
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "failed" ? (
        <div className="space-y-4">
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
            <Button onClick={handleRetry} type="button">
              {t("connectors.nextcloud.dialog.tryAgain")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Add / reconnect dialog for a `login_flow` connector (Nextcloud). The member
 * provides the server, folders and name (add) or nothing (reconnect); the
 * backend runs the browser login and hands back the connector. The flow id and
 * login URL are held only in this component's state and are never rendered into
 * a URL, cache, storage, analytics event or log. A fresh body mounts per open,
 * so polling stops when the dialog closes.
 */
export function AddLoginFlowDialog({ open, ...rest }: LoginFlowDialogProps) {
  return (
    <Dialog onOpenChange={rest.onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        {open ? <LoginFlowBody {...rest} /> : null}
      </DialogContent>
    </Dialog>
  );
}
