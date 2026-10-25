"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  desktopBridge,
  type SandboxReadiness,
} from "../../../../lib/desktop-bridge";
import { sandboxSetupCard } from "../../../../lib/sandbox-setup";

type Props = {
  readiness: SandboxReadiness | undefined;
  /** Called with the readiness returned by an install, or undefined to re-read the status. */
  onChanged: (readiness?: SandboxReadiness) => void | Promise<void>;
};

/** "Set up local execution": shown only while the host reports `needsSetup`. */
export function LocalSandboxSetupCard({ readiness, onChanged }: Props) {
  const t = useTranslations("dashboardSettings");
  const card = sandboxSetupCard(readiness);
  const [busy, setBusy] = useState<"install" | "setup" | "check" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!card) return null;

  const run = async (
    kind: "install" | "setup" | "check",
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
      {card.installing && (
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
            disabled={busy !== null}
            onClick={() =>
              void run("install", () => desktopBridge.installSandboxRuntime())
            }
          >
            {busy === "install"
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
            {t("localHost.setup.privilegedSetupDescription")}
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
            disabled={busy !== null}
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
      {card.action !== "install" && !card.installing && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void run("check", async () => undefined)}
        >
          {t("localHost.setup.checkAgain")}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
