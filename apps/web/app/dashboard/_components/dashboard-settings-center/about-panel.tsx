"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { BUILD_TIME, SHORT_BUILD_SHA } from "../../../../lib/app-version";
import { publicWebBaseUrl } from "../../../../lib/public-runtime-config";
import {
  desktopBridge,
  type DesktopInfo,
} from "../../../../lib/desktop-bridge";
import { SourceWeftBrandMark } from "../../../_landing/components/sourceweft-brand";
import { DesktopUpdatePanel } from "./desktop-update-panel";

// The native host is injected before the app mounts; viewport width does not
// distinguish a desktop browser from the installed PC client.
const subscribe = () => () => {};
const serverSnapshot = () => false;

function formatBuildDate(value: string) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString().slice(0, 10);
}

export function AboutPanel() {
  const isDesktop = React.useSyncExternalStore(
    subscribe,
    desktopBridge.isAvailable,
    serverSnapshot,
  );
  const [info, setInfo] = React.useState<DesktopInfo | null>(null);
  const [infoFailed, setInfoFailed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    void desktopBridge.info().then(
      (value) => {
        if (active) setInfo(value);
      },
      () => {
        if (active) setInfoFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [isDesktop]);

  const buildDate = formatBuildDate(BUILD_TIME);

  let versionLabel: string;
  if (!isDesktop) {
    versionLabel = `build ${SHORT_BUILD_SHA}`;
  } else if (info) {
    versionLabel = info.appVersion;
  } else {
    versionLabel = infoFailed ? "Unavailable" : "Loading...";
  }

  const detail = isDesktop
    ? info
      ? `Desktop app · ${info.platform} ${info.arch}`
      : "Desktop app"
    : buildDate
      ? `Web · ${buildDate}`
      : "Web";

  const copyValue = isDesktop
    ? `SourceWeft desktop ${info?.appVersion ?? "unknown"}${info ? ` (${info.platform} ${info.arch})` : ""}`
    : `SourceWeft web build ${SHORT_BUILD_SHA}${buildDate ? ` (${buildDate})` : ""}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">About</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Details about the SourceWeft client you are running. Include them when
          you report a problem.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 p-4">
        <SourceWeftBrandMark className="size-9 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">SourceWeft</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail}
          </p>
        </div>
        <span className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground">
          {versionLabel}
        </span>
        <Button
          aria-label="Copy version details"
          onClick={handleCopy}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>

      {isDesktop && info?.updaterProtocolVersion === 1 && (
        <DesktopUpdatePanel />
      )}
      {isDesktop && info && info.updaterProtocolVersion === undefined && (
        <button
          className="text-xs underline"
          type="button"
          onClick={() => {
            void desktopBridge.openExternalUrl(
              `${publicWebBaseUrl()}/download`,
            );
          }}
        >
          Install the latest desktop app to enable automatic updates
        </button>
      )}

      {/* The desktop window refuses to navigate outside /dashboard and /auth, so
          the changelog opens in the system browser instead of in-app. */}
      {isDesktop ? (
        <button
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          onClick={() => {
            void desktopBridge.openExternalUrl(
              `${publicWebBaseUrl()}/changelog`,
            );
          }}
          type="button"
        >
          View changelog
        </button>
      ) : (
        <Link
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          href="/changelog"
        >
          View changelog
        </Link>
      )}
    </div>
  );
}
