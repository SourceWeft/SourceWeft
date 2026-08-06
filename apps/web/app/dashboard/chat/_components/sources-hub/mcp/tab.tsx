import { CircleAlert, Loader2 } from "lucide-react";
import { useMemo } from "react";

import type { McpToolSelection, WorkspaceMcpInstall } from "@sourceweft/sdk";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { formatShortRelativeTime } from "../../../../../../lib/relative-time";
import { McpIcon } from "../../../../_components/dashboard-icons";
import { HubEmptyState } from "../components/hub-empty-state";
import { TypeBadge } from "../type-badge";

function installStatusDotClass(status: WorkspaceMcpInstall["status"]): string {
  if (status === "error") return "bg-red-500";
  if (status === "disabled") return "bg-muted-foreground/50";
  return "bg-emerald-500";
}

function McpRow({
  install,
  selectedInstallIds,
  selectedToolIds,
  onSelectionChange,
}: {
  install: WorkspaceMcpInstall;
  selectedInstallIds: string[];
  selectedToolIds: string[];
  onSelectionChange: (selection: McpToolSelection) => void;
}) {
  const selectedInstallSet = useMemo(
    () => new Set(selectedInstallIds),
    [selectedInstallIds],
  );
  const selectedToolSet = useMemo(
    () => new Set(selectedToolIds),
    [selectedToolIds],
  );
  const disabled =
    !install.enabled ||
    !install.webExecutable ||
    install.desktopOnly ||
    (install.authType !== "none" && install.credentialStatus !== "configured");
  const selected = selectedInstallSet.has(install.id);
  const enabledTools = install.tools.filter((tool) => tool.enabled);
  const selectedToolCount = enabledTools.filter((tool) =>
    selectedToolSet.has(tool.id),
  ).length;

  function emit(nextInstallIds: string[], nextToolIds = selectedToolIds) {
    onSelectionChange({
      enabled: nextInstallIds.length > 0 || nextToolIds.length > 0,
      installIds: nextInstallIds,
      toolIds: nextToolIds,
    });
  }

  function toggleInstall() {
    if (disabled) return;
    if (selected) {
      emit(
        selectedInstallIds.filter((id) => id !== install.id),
        selectedToolIds.filter(
          (id) => !enabledTools.some((tool) => tool.id === id),
        ),
      );
      return;
    }
    // Selecting the whole install means "all its tools": drop any of this
    // install's individually-picked tools so the request doesn't carry both
    // installIds:[X] and toolIds:[X's tools] (which double-counts in the tab
    // badge and, because a non-empty toolIds filters the mount, would actually
    // narrow the install back down to just those tools).
    emit(
      [...selectedInstallIds, install.id],
      selectedToolIds.filter(
        (id) => !enabledTools.some((tool) => tool.id === id),
      ),
    );
  }

  function toggleTool(toolId: string) {
    if (disabled || selected) return;
    const nextToolIds = selectedToolSet.has(toolId)
      ? selectedToolIds.filter((id) => id !== toolId)
      : [...selectedToolIds, toolId];
    emit(selectedInstallIds, nextToolIds);
  }

  return (
    <article
      className={cn(
        "rounded-md px-2 py-2 transition-colors",
        selected || selectedToolCount > 0
          ? "bg-primary/5"
          : "hover:bg-accent/60",
        disabled && "opacity-55",
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={selected}
          className="mt-0.5"
          disabled={disabled}
          onCheckedChange={toggleInstall}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <McpIcon
              className={cn(
                "size-3 shrink-0",
                selected ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {install.name}
            </span>
            <TypeBadge
              label={
                install.official
                  ? "Official"
                  : install.verified
                    ? "Verified"
                    : "Unverified"
              }
            />
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
            {install.summary}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <TypeBadge label={install.transport.replaceAll("_", " ")} />
            {install.authType !== "none" ? (
              <TypeBadge
                label={
                  install.credentialStatus === "configured"
                    ? "Auth configured"
                    : "Auth required"
                }
              />
            ) : null}
            {!install.webExecutable || install.desktopOnly ? (
              <TypeBadge label="Desktop only" />
            ) : null}
            {!install.enabled ? <TypeBadge label="Disabled" /> : null}
            <span
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
              title={install.lastError ?? undefined}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  installStatusDotClass(install.status),
                )}
              />
              {install.lastTestedAt
                ? `Tested ${formatShortRelativeTime(install.lastTestedAt)}`
                : "Not tested"}
            </span>
          </div>
        </div>
      </div>

      {enabledTools.length > 0 ? (
        <div className="mt-2 space-y-1 pl-6">
          {enabledTools.slice(0, 8).map((tool) => (
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-accent/60",
                (disabled || selected) &&
                  "cursor-not-allowed hover:bg-transparent",
              )}
              key={tool.id}
            >
              <Checkbox
                checked={selected || selectedToolSet.has(tool.id)}
                className="mt-0.5 size-3.5"
                disabled={disabled || selected}
                onCheckedChange={() => toggleTool(tool.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">
                  {tool.title ?? tool.serverToolName}
                </span>
                {tool.description ? (
                  <span className="line-clamp-1 text-[10px] text-muted-foreground">
                    {tool.description}
                  </span>
                ) : null}
              </span>
              <TypeBadge label={tool.risk} />
            </label>
          ))}
          {enabledTools.length > 8 ? (
            <div className="px-1.5 text-[10px] text-muted-foreground">
              {enabledTools.length - 8} more tools are available when the server
              is selected.
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function McpTab({
  installs,
  isLoading,
  loadingError,
  onSelectionChange,
  searchQuery,
  selectedInstallIds,
  selectedToolIds,
}: {
  installs: WorkspaceMcpInstall[];
  isLoading: boolean;
  loadingError: string | null;
  onSelectionChange: (selection: McpToolSelection) => void;
  searchQuery: string;
  selectedInstallIds: string[];
  selectedToolIds: string[];
}) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? installs.filter(
            (install) =>
              install.name.toLowerCase().includes(q) ||
              install.summary.toLowerCase().includes(q) ||
              install.tools.some(
                (tool) =>
                  tool.serverToolName.toLowerCase().includes(q) ||
                  (tool.title ?? "").toLowerCase().includes(q) ||
                  (tool.description ?? "").toLowerCase().includes(q),
              ),
          )
        : installs,
    [installs, q],
  );

  // Only take over the whole panel with an error/spinner when there is nothing
  // to show yet. With cached installs already rendered, a background refresh
  // (which toggles isLoading) or a transient error must not blank them out —
  // otherwise the stale-while-revalidate cache is never actually displayed.
  if (loadingError && installs.length === 0) {
    return (
      <HubEmptyState
        description={loadingError}
        icon={CircleAlert}
        title="MCP tools could not be loaded."
      />
    );
  }

  if (isLoading && installs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
        Loading MCP tools...
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <HubEmptyState
        description={
          searchQuery
            ? "Try a different server, tool, or description."
            : "Install MCP servers from the MCP Market to use them in chat."
        }
        icon={McpIcon}
        title={
          searchQuery
            ? `No MCP tools match "${searchQuery}"`
            : "No MCP tools installed."
        }
      />
    );
  }

  return (
    <div className="space-y-1">
      {filtered.map((install) => (
        <McpRow
          install={install}
          key={install.id}
          onSelectionChange={onSelectionChange}
          selectedInstallIds={selectedInstallIds}
          selectedToolIds={selectedToolIds}
        />
      ))}
    </div>
  );
}
