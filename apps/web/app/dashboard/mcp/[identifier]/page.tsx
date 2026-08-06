"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
  Scale,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  marketMcpManifestSchema,
  type McpRiskLevel,
} from "@sourceweft/market-contracts";
import type { WorkspaceMcpInstall } from "@sourceweft/sdk";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { contentClient, workspaceClient } from "../../../../lib/sdk";
import { formatShortRelativeTime } from "../../../../lib/relative-time";
import { useDashboardChatState } from "../../_components/dashboard-chat-state";
import { McpIcon } from "../../_components/dashboard-icons";
import { invalidateWorkspaceMcpCache } from "../../chat/_components/sources-hub/mcp/use-mcp";
import { CredentialsDialog } from "../_components/mcp-credentials-dialog";

type MarketMcpDetail = Awaited<
  ReturnType<typeof contentClient.getWorkspaceMarketMcp>
>;

type ResolvedWorkspace = {
  id: string;
  name: string | null;
};

function riskMeta(risk: McpRiskLevel): { label: string; className: string } {
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

function formatUpdated(value: string | null) {
  if (!value) return "Unknown";
  return formatShortRelativeTime(value);
}

export default function McpDetailPage() {
  const params = useParams<{ identifier?: string | string[] }>();
  const rawIdentifier = Array.isArray(params.identifier)
    ? params.identifier[0]
    : params.identifier;
  // Next.js already decodes dynamic route params once; decoding again would
  // corrupt identifiers that legitimately contain "%" sequences.
  const identifier = rawIdentifier ?? null;
  const dashboardState = useDashboardChatState();
  const [workspace, setWorkspace] = React.useState<ResolvedWorkspace | null>(
    null,
  );
  const [detail, setDetail] = React.useState<MarketMcpDetail | null>(null);
  const [install, setInstall] = React.useState<WorkspaceMcpInstall | null>(null);
  const [isResolvingWorkspace, setIsResolvingWorkspace] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [credentialsOpen, setCredentialsOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [iconFailed, setIconFailed] = React.useState(false);
  const detailGenerationRef = React.useRef(0);

  const resolveWorkspace = React.useCallback(async () => {
    if (dashboardState.workspaceId) {
      return {
        id: dashboardState.workspaceId,
        name: dashboardState.workspaceName,
      };
    }
    const current = await workspaceClient.getCurrentContext();
    if (current.activeWorkspace) {
      return {
        id: current.activeWorkspace.id,
        name: current.activeWorkspace.name,
      };
    }
    return null;
  }, [dashboardState.workspaceId, dashboardState.workspaceName]);

  const loadDetail = React.useCallback(async () => {
    const generation = ++detailGenerationRef.current;
    setError(null);
    setIsResolvingWorkspace(true);
    try {
      const resolved = await resolveWorkspace();
      if (detailGenerationRef.current !== generation) return;
      setWorkspace(resolved);
      if (!resolved) {
        setDetail(null);
        return;
      }
      if (!identifier) {
        setDetail(null);
        setError("MCP identifier is missing.");
        return;
      }

      setIsLoading(true);
      const result = await contentClient.getWorkspaceMarketMcp(
        resolved.id,
        identifier,
      );
      if (detailGenerationRef.current !== generation) return;
      setDetail(result);
      setInstall(result.install);
    } catch (loadError) {
      if (detailGenerationRef.current !== generation) return;
      setDetail(null);
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load MCP.",
      );
    } finally {
      if (detailGenerationRef.current === generation) {
        setIsResolvingWorkspace(false);
        setIsLoading(false);
      }
    }
  }, [identifier, resolveWorkspace]);

  React.useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const item = detail?.market.item ?? null;

  React.useEffect(() => {
    setIconFailed(false);
  }, [item?.iconUrl]);

  // The catalog exposes the typed manifest only inside the untyped version
  // record; parse the latest published version so we can list tools and the
  // long-form description even before the server is installed.
  const manifest = React.useMemo(() => {
    if (!detail) return null;
    const versions = detail.market.versions;
    const version =
      versions.find((entry) => entry.version === detail.market.item.latestVersion) ??
      versions[0];
    if (!version) return null;
    const parsed = marketMcpManifestSchema.safeParse(version.manifestJson);
    return parsed.success ? parsed.data : null;
  }, [detail]);

  const trusted = Boolean(item?.official || item?.verified);
  const desktopOnly = Boolean(item && (item.desktopOnly || !item.webExecutable));
  const tools = manifest?.tools ?? [];
  const description = manifest?.description ?? item?.summary ?? "";
  const sourceUrl = manifest?.sourceUrl ?? item?.sourceUrl ?? null;
  const repoUrl = manifest?.repoUrl ?? item?.repoUrl ?? null;
  const homepageUrl = manifest?.homepageUrl ?? item?.homepageUrl ?? null;
  const needsCredentials =
    install &&
    install.authType !== "none" &&
    install.credentialStatus !== "configured";

  async function installMcp() {
    if (!workspace || !item || install) return;
    setPending(true);
    try {
      const result = await contentClient.installMarketMcp(
        workspace.id,
        item.identifier,
        {},
      );
      setInstall(result.install);
      invalidateWorkspaceMcpCache(workspace.id);
      toast.success("MCP installed");
      // Installing an auth server prompts for credentials; the user then Tests
      // to verify connectivity. Install and Test are deliberately separate.
      if (result.install.authType !== "none") {
        setCredentialsOpen(true);
      }
    } catch (installError) {
      toast.error(
        installError instanceof Error
          ? installError.message
          : "Failed to install MCP.",
      );
    } finally {
      setPending(false);
    }
  }

  async function uninstallMcp() {
    if (!workspace || !install) return;
    setPending(true);
    try {
      await contentClient.deleteWorkspaceMcpInstall(workspace.id, install.id);
      setInstall(null);
      invalidateWorkspaceMcpCache(workspace.id);
      toast.success("MCP uninstalled");
    } catch (uninstallError) {
      toast.error(
        uninstallError instanceof Error
          ? uninstallError.message
          : "Failed to uninstall MCP.",
      );
    } finally {
      setPending(false);
    }
  }

  async function testInstall() {
    if (!workspace || !install) return;
    setPending(true);
    try {
      const result = await contentClient.testWorkspaceMcpInstall(
        workspace.id,
        install.id,
      );
      setInstall(result.install);
      invalidateWorkspaceMcpCache(workspace.id);
      toast.success(`MCP connection tested: ${result.toolCount} tools`);
    } catch (testError) {
      toast.error(
        testError instanceof Error ? testError.message : "Failed to test MCP.",
      );
    } finally {
      setPending(false);
    }
  }

  async function toggleInstall(enabled: boolean) {
    if (!workspace || !install) return;
    setPending(true);
    try {
      const result = await contentClient.updateWorkspaceMcpInstall(
        workspace.id,
        install.id,
        { enabled },
      );
      setInstall(result.install);
      invalidateWorkspaceMcpCache(workspace.id);
      toast.success(enabled ? "MCP enabled" : "MCP disabled");
    } catch (toggleError) {
      toast.error(
        toggleError instanceof Error
          ? toggleError.message
          : "Failed to update MCP.",
      );
    } finally {
      setPending(false);
    }
  }

  const pageLoading = isResolvingWorkspace || isLoading;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                asChild
                aria-label="Back to MCP market"
                className="h-8 w-8 rounded-full p-0"
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Link href="/dashboard/mcp">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
              {item ? (
                <>
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
                      // Registry/derived icons come from arbitrary https hosts, so
                      // Next Image's static remote-host allowlist does not apply.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt=""
                        className="size-full object-contain"
                        loading="lazy"
                        onError={() => setIconFailed(true)}
                        referrerPolicy="no-referrer"
                        src={item.iconUrl}
                      />
                    ) : (
                      <McpIcon className="h-5 w-5" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <h1 className="truncate text-base font-semibold text-foreground">
                      {item.name}
                    </h1>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {item.official ? (
                        <Badge className="h-5 px-1.5 text-[10px]" variant="default">
                          Official
                        </Badge>
                      ) : item.verified ? (
                        <Badge
                          className="h-5 px-1.5 text-[10px]"
                          variant="secondary"
                        >
                          Verified
                        </Badge>
                      ) : (
                        <Badge
                          className="h-5 gap-1 px-1.5 text-[10px]"
                          variant="outline"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          Unverified
                        </Badge>
                      )}
                      <Badge className="h-5 px-1.5 text-[10px]" variant="outline">
                        {desktopOnly ? "Desktop only" : "Web executable"}
                      </Badge>
                      {install ? (
                        <Badge
                          className="h-5 gap-1 px-1.5 text-[10px]"
                          variant="secondary"
                        >
                          <Check className="h-3 w-3" />
                          Installed
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : (
                <h1 className="truncate text-base font-semibold text-foreground">
                  MCP details
                </h1>
              )}
            </div>

            {item ? (
              <div className="flex flex-wrap items-center gap-2">
                {install ? (
                  <>
                    <Button
                      className="h-8 px-3 text-xs"
                      disabled={pending}
                      onClick={() => void testInstall()}
                      size="sm"
                      type="button"
                    >
                      {pending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <PlugZap className="h-3.5 w-3.5" />
                      )}
                      Test
                    </Button>
                    <Button
                      className="h-8 px-3 text-xs"
                      disabled={pending}
                      onClick={() => setCredentialsOpen(true)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      Settings
                    </Button>
                    <Button
                      className="h-8 px-3 text-xs"
                      disabled={pending}
                      onClick={() => void uninstallMcp()}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {pending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      Uninstall
                    </Button>
                  </>
                ) : (
                  <Button
                    className="h-8 px-3 text-xs"
                    disabled={pending}
                    onClick={() => void installMcp()}
                    size="sm"
                    type="button"
                  >
                    {pending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <McpIcon className="h-3.5 w-3.5" />
                    )}
                    Install
                  </Button>
                )}
              </div>
            ) : null}
          </div>

          {error ? (
            <p className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p>
          ) : null}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <article className="min-w-0 space-y-4">
              {pageLoading ? (
                <div className="flex items-center justify-center rounded-2xl border border-border bg-background px-5 py-16 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading MCP...
                </div>
              ) : error && !item ? (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-10 text-sm text-destructive">
                  {error}
                </div>
              ) : item ? (
                <>
                  <section className="rounded-2xl border border-border bg-background p-5 shadow-xs">
                    <p className="text-xs text-muted-foreground">
                      {item.providerName ?? item.identifier}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-foreground">
                      {description}
                    </p>
                    {install ? (
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
                        <div className="min-w-0">
                          <div>
                            {install.tools.length} tool
                            {install.tools.length === 1 ? "" : "s"} synced
                            {install.lastTestedAt
                              ? ` · tested ${formatShortRelativeTime(install.lastTestedAt)}`
                              : " · not tested yet"}
                          </div>
                          {install.lastError ? (
                            <div className="mt-1 inline-flex items-center gap-1 text-red-600 dark:text-red-300">
                              <AlertTriangle className="h-3 w-3" />
                              {install.lastError}
                            </div>
                          ) : null}
                          {needsCredentials ? (
                            <button
                              className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={() => setCredentialsOpen(true)}
                              type="button"
                            >
                              <KeyRound className="h-3 w-3" />
                              Configure credentials
                            </button>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span>{install.enabled ? "Enabled" : "Disabled"}</span>
                          <Switch
                            checked={install.enabled}
                            disabled={pending}
                            onCheckedChange={(checked) =>
                              void toggleInstall(checked)
                            }
                          />
                        </div>
                      </div>
                    ) : null}
                  </section>

                  {!trusted ? (
                    <section className="flex gap-2 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        This MCP server is unverified. It can receive a
                        conversation&apos;s tool arguments and may perform
                        external actions. Review the server before enabling it.
                      </span>
                    </section>
                  ) : null}

                  <section className="rounded-2xl border border-border bg-background p-5 shadow-xs">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-foreground">
                        Tools
                      </h2>
                      <span className="text-xs text-muted-foreground">
                        {tools.length || item.toolsCount} total
                      </span>
                    </div>
                    {tools.length === 0 ? (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Tool details are published after the server is indexed or
                        installed.
                      </p>
                    ) : (
                      <ul className="mt-3 space-y-2">
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
                </>
              ) : (
                <div className="rounded-2xl border border-border bg-background px-5 py-10 text-sm text-muted-foreground">
                  MCP server was not found in this workspace catalog.
                </div>
              )}
            </article>

            {item ? (
              <aside className="space-y-4">
                <section className="h-fit rounded-2xl border border-border bg-background p-4 shadow-xs">
                  <h2 className="text-sm font-semibold text-foreground">
                    Server details
                  </h2>
                  <dl className="mt-3 space-y-3 text-xs">
                    {[
                      ["Identifier", item.identifier],
                      ["Version", item.latestVersion ?? "Unknown"],
                      [
                        "Transport",
                        manifest?.transport ?? item.transport ?? "Unknown",
                      ],
                      ["Runtime", item.runtime],
                      [
                        "Auth",
                        item.requiresAuth ? "Required" : "Not required",
                      ],
                      ["Tools", String(tools.length || item.toolsCount)],
                      ["Updated", formatUpdated(item.updatedAt)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="mt-0.5 font-medium text-foreground capitalize">
                          {value}
                        </dd>
                      </div>
                    ))}
                    {item.license ? (
                      <div>
                        <dt className="text-muted-foreground">License</dt>
                        <dd className="mt-0.5 inline-flex items-center gap-1 font-medium text-foreground">
                          <Scale className="h-3 w-3" />
                          {item.license}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {sourceUrl || repoUrl || homepageUrl ? (
                    <div className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3 text-xs">
                      {homepageUrl ? (
                        <a
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                          href={homepageUrl}
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Homepage
                        </a>
                      ) : null}
                      {repoUrl ? (
                        <a
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                          href={repoUrl}
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Repository
                        </a>
                      ) : null}
                      {sourceUrl ? (
                        <a
                          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                          href={sourceUrl}
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Source
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                {item.categories.length > 0 ? (
                  <section className="rounded-2xl border border-border bg-background p-4 shadow-xs">
                    <h2 className="text-sm font-semibold text-foreground">
                      Categories
                    </h2>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {item.categories.map((category) => (
                        <Badge
                          className="h-5 px-1.5 text-[10px] capitalize"
                          key={category}
                          variant="outline"
                        >
                          {category}
                        </Badge>
                      ))}
                    </div>
                  </section>
                ) : null}

                <section className="rounded-2xl border border-border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">
                  <div className="mb-1.5 inline-flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Runtime & security
                  </div>
                  <p>
                    Credentials are configured privately per workspace, encrypted
                    at rest, and sent only to this server during tool calls.
                    {desktopOnly
                      ? " This server runs on the desktop host only."
                      : " This server runs from the web runtime when configured."}
                  </p>
                </section>
              </aside>
            ) : null}
          </div>
        </ScrollArea>
      </section>

      <CredentialsDialog
        install={install}
        onClose={() => setCredentialsOpen(false)}
        onSaved={setInstall}
        open={credentialsOpen}
        workspaceId={workspace?.id ?? null}
      />
    </main>
  );
}
