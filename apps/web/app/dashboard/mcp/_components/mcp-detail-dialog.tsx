"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
  RotateCw,
  Scale,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  marketMcpManifestSchema,
  type McpRiskLevel,
} from "@sourceweft/market-contracts";
import type {
  ListWorkspaceMarketMcpResponse,
  WorkspaceMcpInstall,
} from "@sourceweft/sdk";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient } from "../../../../lib/sdk";
import { formatShortRelativeTime } from "../../../../lib/relative-time";
import { McpIcon } from "../../_components/dashboard-icons";

type MarketMcpItem = ListWorkspaceMarketMcpResponse["items"][number];
type MarketMcpDetail = Awaited<
  ReturnType<typeof contentClient.getWorkspaceMarketMcp>
>;

function riskMeta(risk: McpRiskLevel) {
  if (risk === "destructive") {
    return {
      label: "Destructive",
      className:
        "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    };
  }
  if (risk === "write") {
    return {
      label: "Write",
      className:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  if (risk === "read") {
    return {
      label: "Read",
      className:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  return { label: "Unknown", className: "text-muted-foreground" };
}

function McpAvatar({ item }: { item: MarketMcpItem["market"] }) {
  const trusted = item.official || item.verified;
  const [iconFailed, setIconFailed] = React.useState(false);

  React.useEffect(() => setIconFailed(false), [item.iconUrl]);

  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full shadow-sm",
        item.iconUrl && !iconFailed
          ? "border border-border bg-white"
          : trusted
            ? "bg-linear-to-br from-emerald-500 via-sky-500 to-blue-500 text-white"
            : "bg-linear-to-br from-amber-500 via-orange-500 to-rose-500 text-white",
      )}
    >
      {item.iconUrl && !iconFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="size-full object-contain"
          onError={() => setIconFailed(true)}
          referrerPolicy="no-referrer"
          src={item.iconUrl}
        />
      ) : (
        <McpIcon className="size-5" />
      )}
    </span>
  );
}

export function McpDetailDialog({
  item,
  onConfigure,
  onInstall,
  onOpenChange,
  onTest,
  onToggleEnabled,
  onUninstall,
  pending,
  workspaceId,
}: {
  item: MarketMcpItem | null;
  onConfigure: (install: WorkspaceMcpInstall) => void;
  onInstall: (item: MarketMcpItem) => void;
  onOpenChange: (open: boolean) => void;
  onTest: (install: WorkspaceMcpInstall) => void;
  onToggleEnabled: (install: WorkspaceMcpInstall, enabled: boolean) => void;
  onUninstall: (item: MarketMcpItem) => void;
  pending: boolean;
  workspaceId: string | null;
}) {
  const [detail, setDetail] = React.useState<MarketMcpDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const generationRef = React.useRef(0);
  const identifier = item?.market.identifier ?? null;

  React.useEffect(() => {
    const generation = ++generationRef.current;
    if (!identifier || !workspaceId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    setDetail(null);
    setError(null);
    setLoading(true);
    void contentClient
      .getWorkspaceMarketMcp(workspaceId, identifier)
      .then((result) => {
        if (generationRef.current !== generation) return;
        setDetail(result);
      })
      .catch((loadError) => {
        if (generationRef.current !== generation) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load MCP details.",
        );
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
  }, [identifier, reloadKey, workspaceId]);

  const market = item?.market ?? null;
  const install = item?.install ?? null;
  const manifest = React.useMemo(() => {
    if (!detail) return null;
    const version =
      detail.market.versions.find(
        (entry) => entry.version === detail.market.item.latestVersion,
      ) ?? detail.market.versions[0];
    if (!version) return null;
    const parsed = marketMcpManifestSchema.safeParse(version.manifestJson);
    return parsed.success ? parsed.data : null;
  }, [detail]);
  const trusted = Boolean(market?.official || market?.verified);
  const desktopOnly = Boolean(
    market && (market.desktopOnly || !market.webExecutable),
  );
  const tools = manifest?.tools ?? [];
  const description = manifest?.description ?? market?.summary ?? "";
  const sourceUrl = manifest?.sourceUrl ?? market?.sourceUrl ?? null;
  const repoUrl = manifest?.repoUrl ?? market?.repoUrl ?? null;
  const homepageUrl = manifest?.homepageUrl ?? market?.homepageUrl ?? null;
  const needsCredentials =
    install &&
    install.authType !== "none" &&
    install.credentialStatus !== "configured";

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[calc(100svh-2rem)] w-[min(1120px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <DialogHeader className="border-b border-border px-5 py-4 pr-16 text-left">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {market ? <McpAvatar item={market} /> : null}
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {market?.name ?? "MCP details"}
                </DialogTitle>
                <DialogDescription className="mt-1 truncate text-xs">
                  {market?.providerName ??
                    market?.identifier ??
                    "Loading MCP details."}
                </DialogDescription>
              </div>
            </div>
            {market && item ? (
              <div className="mr-3 flex shrink-0 flex-wrap items-center justify-end gap-2">
                {install ? (
                  <>
                    <Button
                      disabled={pending}
                      onClick={() => onTest(install)}
                      size="sm"
                      type="button"
                    >
                      {pending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <PlugZap className="size-3.5" />
                      )}
                      Test
                    </Button>
                    <Button
                      disabled={pending}
                      onClick={() => onConfigure(install)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Settings2 className="size-3.5" />
                      Settings
                    </Button>
                    <Button
                      disabled={pending}
                      onClick={() => onUninstall(item)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="size-3.5" />
                      Uninstall
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={pending}
                    onClick={() => onInstall(item)}
                    size="sm"
                    type="button"
                  >
                    {pending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <McpIcon className="size-3.5" />
                    )}
                    Install
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading MCP...
            </div>
          ) : error ? (
            <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-5 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                onClick={() => setReloadKey((current) => current + 1)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RotateCw className="size-4" />
                Retry
              </Button>
            </div>
          ) : market ? (
            <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_280px]">
              <article className="min-w-0 space-y-4">
                <section className="rounded-lg border border-border bg-background p-5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {market.official ? (
                      <Badge variant="default">Official</Badge>
                    ) : market.verified ? (
                      <Badge variant="secondary">Verified</Badge>
                    ) : (
                      <Badge className="gap-1" variant="outline">
                        <AlertTriangle className="size-3" />
                        Unverified
                      </Badge>
                    )}
                    <Badge variant="outline">
                      {desktopOnly ? "Desktop only" : "Web executable"}
                    </Badge>
                    {install ? (
                      <Badge className="gap-1" variant="secondary">
                        <Check className="size-3" />
                        Installed
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-4 text-sm leading-6 text-foreground">
                    {description}
                  </p>
                  {install ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
                      <div className="min-w-0">
                        <p>
                          {install.tools.length} tool
                          {install.tools.length === 1 ? "" : "s"} synced
                          {install.lastTestedAt
                            ? ` · tested ${formatShortRelativeTime(install.lastTestedAt)}`
                            : " · not tested yet"}
                        </p>
                        {install.lastError ? (
                          <p className="mt-1 text-destructive">
                            {install.lastError}
                          </p>
                        ) : null}
                        {needsCredentials ? (
                          <button
                            className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
                            onClick={() => onConfigure(install)}
                            type="button"
                          >
                            <KeyRound className="size-3" />
                            Configure credentials
                          </button>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <span>{install.enabled ? "Enabled" : "Disabled"}</span>
                        <Switch
                          aria-label={`${install.enabled ? "Disable" : "Enable"} ${market.name}`}
                          checked={install.enabled}
                          disabled={pending}
                          onCheckedChange={(enabled) =>
                            onToggleEnabled(install, enabled)
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                </section>

                {!trusted ? (
                  <section className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    This MCP server is unverified. Review it before enabling
                    access to conversation tool arguments.
                  </section>
                ) : null}

                <section className="rounded-lg border border-border bg-background p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-foreground">
                      Tools
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {tools.length || market.toolsCount} total
                    </span>
                  </div>
                  {tools.length === 0 ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Tool details are published after the server is indexed or
                      installed.
                    </p>
                  ) : (
                    <ul className="mt-3 grid gap-2 md:grid-cols-2">
                      {tools.map((tool) => {
                        const meta = riskMeta(tool.risk);
                        return (
                          <li
                            className="rounded-lg border border-border bg-card/40 px-3 py-2"
                            key={tool.name}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
                                {tool.title ?? tool.name}
                              </span>
                              <Badge
                                className={cn(
                                  "h-5 shrink-0 px-1.5 text-[10px]",
                                  meta.className,
                                )}
                                variant="outline"
                              >
                                {meta.label}
                              </Badge>
                            </div>
                            {tool.description ? (
                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                {tool.description}
                              </p>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </article>

              <aside className="space-y-4">
                <section className="rounded-lg border border-border bg-background p-4">
                  <h2 className="text-sm font-semibold text-foreground">
                    Server details
                  </h2>
                  <dl className="mt-3 space-y-3 text-xs">
                    {[
                      ["Identifier", market.identifier],
                      ["Version", market.latestVersion ?? "Unknown"],
                      [
                        "Transport",
                        manifest?.transport ?? market.transport ?? "Unknown",
                      ],
                      ["Runtime", market.runtime],
                      [
                        "Auth",
                        market.requiresAuth ? "Required" : "Not required",
                      ],
                      ["Tools", String(tools.length || market.toolsCount)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="mt-1 break-words font-medium text-foreground">
                          {value}
                        </dd>
                      </div>
                    ))}
                    {market.license ? (
                      <div>
                        <dt className="text-muted-foreground">License</dt>
                        <dd className="mt-1 inline-flex items-center gap-1 font-medium text-foreground">
                          <Scale className="size-3" />
                          {market.license}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  {homepageUrl || repoUrl || sourceUrl ? (
                    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3 text-xs">
                      {[
                        ["Homepage", homepageUrl],
                        ["Repository", repoUrl],
                        ["Source", sourceUrl],
                      ].map(([label, href]) =>
                        href ? (
                          <a
                            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                            href={href}
                            key={label}
                            rel="noreferrer noopener"
                            target="_blank"
                          >
                            <ExternalLink className="size-3" />
                            {label}
                          </a>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                </section>

                <section className="rounded-lg border border-border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">
                  <div className="mb-1.5 inline-flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldCheck className="size-3.5" />
                    Runtime & security
                  </div>
                  Credentials are encrypted per workspace and sent only to this
                  server during tool calls.
                </section>
              </aside>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
