"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@sourceweft/ui-web/components/ui/dialog";
import { desktopBridge, type DesktopInfo } from "../../../lib/desktop-bridge";
import { publicRuntimeConfig } from "../../../lib/public-runtime-config";
import {
  localCalendarDate,
  recoveryDismissalKey,
  recoveryDownload,
} from "../../../lib/desktop-recovery";

export function DesktopRecovery({ panel = false }: { panel?: boolean }) {
  const t = useTranslations("dashboardSettings.desktopRecovery");
  const [candidate, setCandidate] = useState<{
    info: DesktopInfo;
    url: string;
    version: string;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const release = publicRuntimeConfig().desktopRecoveryRelease;
    if (
      !release ||
      !desktopBridge.isAvailable() ||
      window.top !== window ||
      /^\/dashboard\/(hub-window|preview-window)(?:\/|$)/.test(
        window.location.pathname,
      )
    )
      return;
    let active = true;
    void desktopBridge
      .info()
      .then((info) => {
        if (!active) return;
        const url = recoveryDownload(release, info);
        if (!url) return;
        setCandidate({ info, url, version: release.version });
        if (panel) return;
        try {
          setOpen(
            localStorage.getItem(recoveryDismissalKey(info)) !==
              localCalendarDate(),
          );
        } catch {
          // Do not claim a durable dismissal when storage is inaccessible.
          setError(t("storageError"));
          setOpen(true);
        }
      })
      .catch(() => {
        // Discovery/network/IPC failures are not proof of an affected version.
      });
    return () => {
      active = false;
    };
  }, [panel, t]);

  if (!candidate) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(
        recoveryDismissalKey(candidate.info),
        localCalendarDate(),
      );
      setOpen(false);
      setError(null);
    } catch {
      setError(t("storageError"));
    }
  };
  const download = async () => {
    setPending(true);
    setError(null);
    try {
      const link = new URL("/api/desktop-recovery", window.location.origin);
      link.searchParams.set(
        "target",
        `${candidate.info.platform}-${candidate.info.arch}`,
      );
      link.searchParams.set("version", candidate.version);
      await desktopBridge.openExternalUrl(link.href);
    } catch {
      setError(t("downloadError"));
    } finally {
      setPending(false);
    }
  };
  const body = (
    <>
      <p className="text-xs text-muted-foreground">
        {t("versions", {
          current: candidate.info.appVersion,
          next: candidate.version,
        })}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer">{t("steps")}</summary>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-muted-foreground">
          <li>{t("stepDownload")}</li>
          <li>{t("stepQuit")}</li>
          <li>
            {t(
              candidate.info.platform === "macos"
                ? "stepMac"
                : candidate.info.platform === "windows"
                  ? "stepWindows"
                  : "stepLinux",
            )}
          </li>
          <li>{t("stepReopen")}</li>
        </ol>
      </details>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => void download()}>
          <ExternalLink />
          {t("download")}
        </Button>
        {!panel && (
          <Button variant="outline" onClick={dismiss}>
            {t("later")}
          </Button>
        )}
      </div>
    </>
  );
  if (panel)
    return (
      <section
        aria-label={t("title")}
        className="space-y-4 rounded-lg border p-4"
      >
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        {body}
      </section>
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
