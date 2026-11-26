"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopBridge,
  type SandboxReadiness,
  type SandboxRuntimeInfo,
} from "../../../../lib/desktop-bridge";
import { sandboxSetupCard } from "../../../../lib/sandbox-setup";
import {
  installSandboxRuntime,
  useSandboxInstallState,
} from "../../../../lib/sandbox-runtime-install";

type Props = {
  readiness: SandboxReadiness | undefined;
  runtime?: SandboxRuntimeInfo;
  /** Called with the readiness returned by an install, or undefined to re-read the status. */
  onChanged: (readiness?: SandboxReadiness) => void | Promise<void>;
};

/** "Set up local execution": shown only while the host reports `needsSetup`. */
export function LocalSandboxSetupCard({
  readiness,
  runtime,
  onChanged,
}: Props) {
  const t = useTranslations("dashboardSettings");
  const card = sandboxSetupCard(readiness);
  const [busy, setBusy] = useState<"setup" | "check" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The runtime install is shared by the page: it also starts by itself when the app opens,
  // and this card shows that run, its failure and its result the same as its own.
  const install = useSandboxInstallState();
  const installsSeen = useRef(install.finished);
  useEffect(() => {
    if (installsSeen.current === install.finished) return;
    installsSeen.current = install.finished;
    void onChanged(install.readiness ?? undefined);
  }, [install.finished, install.readiness, onChanged]);
  // An install running here, or started elsewhere (another window, before a restart), must
  // not be started twice.
  const installing =
    install.phase === "installing" || Boolean(card?.installing);
  const locked = busy !== null || installing;
  if (!card) {
    // A working runtime from an older app version: offer the refresh the app also starts itself.
    if (readiness?.state !== "ready" || !runtime?.updateAvailable) return null;
    return (
      <div
        className="space-y-3 rounded-lg border p-4"
        data-testid="local-sandbox-update"
      >
        <h3 className="font-medium">{t("localHost.setup.updateTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("localHost.setup.updateDescription")}
        </p>
        <Button
          disabled={installing}
          onClick={() => void installSandboxRuntime().catch(() => {})}
        >
          {installing
            ? t("localHost.setup.installing")
            : t("localHost.setup.update")}
        </Button>
        {install.phase === "failed" && install.error && (
          <p role="alert" className="text-sm text-destructive">
            {install.error}
          </p>
        )}
      </div>
    );
  }
  const shownError =
    error ??
    (card.action === "install" && install.phase === "failed"
      ? install.error
      : null);

  const run = async (
    kind: "setup" | "check",
    work: () => Promise<SandboxReadiness | void>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await work();
      await onChanged(next ?? undefined);
    } catch (e) {
      // Errors carry the host's stable code and reason; show them as they are.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (!card.setupCommand) return;
    try {
      await navigator.clipboard.writeText(card.setupCommand);
      setCopied(true);
      setError(null);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="space-y-3 rounded-lg border p-4"
      data-testid="local-sandbox-setup"
    >
      <h3 className="font-medium">{t("localHost.setup.title")}</h3>
      <p className="text-sm">{card.reason}</p>
      {installing && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("localHost.setup.installingInProgress")}
        </p>
      )}
      {card.action === "install" && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("localHost.setup.downloadRuntimeDescription")}
          </p>
          <Button
            disabled={locked}
            onClick={() => {
              setError(null);
              // A failure is kept by the shared install and shown below.
              void installSandboxRuntime().catch(() => {});
            }}
          >
            {install.phase === "installing"
              ? t("localHost.setup.installing")
              : t("localHost.setup.install")}
          </Button>
        </>
      )}
      {card.action === "updateApp" && (
        <p className="text-sm text-muted-foreground">
          {t("localHost.setup.updateAppDescription")}
        </p>
      )}
      {card.action === "reinstallPackage" && (
        <p className="text-sm text-muted-foreground">
          {t("localHost.setup.reinstallPackageDescription")}
        </p>
      )}
      {card.action === "privilegedSetup" && (
        <>
          <p className="text-sm text-muted-foreground">
            {card.setupCommand
              ? t("localHost.setup.privilegedSetupDescription")
              : t("localHost.setup.privilegedSetupNoCommandDescription")}
          </p>
          {card.setupCommand && (
            <div className="flex items-start gap-2">
              <pre
                aria-label={t("localHost.setup.commandLabel")}
                className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
              >
                <code>{card.setupCommand}</code>
              </pre>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copied
                  ? t("localHost.setup.copied")
                  : t("localHost.setup.copy")}
              </Button>
            </div>
          )}
          <Button
            disabled={locked}
            onClick={() =>
              void run("setup", () => desktopBridge.runSandboxPrivilegedSetup())
            }
          >
            {busy === "setup"
              ? t("localHost.setup.runningSetup")
              : t("localHost.setup.runSetup")}
          </Button>
        </>
      )}
      {card.action === "elevatedSetup" && (
        <>
          <p className="text-sm text-muted-foreground">
            {t("localHost.setup.elevatedSetupDescription")}
          </p>
          <Button
            disabled={locked}
            onClick={() =>
              void run("setup", () => desktopBridge.runSandboxPrivilegedSetup())
            }
          >
            {busy === "setup"
              ? t("localHost.setup.elevatedSetupRunning")
              : t("localHost.setup.elevatedSetup")}
          </Button>
        </>
      )}
      {card.action !== "install" && !installing && (
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => void run("check", async () => undefined)}
        >
          {t("localHost.setup.checkAgain")}
        </Button>
      )}
      {shownError && (
        <p role="alert" className="text-sm text-destructive">
          {shownError}
        </p>
      )}
    </div>
  );
}
