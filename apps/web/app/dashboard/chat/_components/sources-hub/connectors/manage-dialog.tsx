import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Link2,
  Loader2,
  Search,
  X,
} from "lucide-react";

import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { HubEmptyState } from "../components/hub-empty-state";
import { connectorCatalog, connectorCatalogCategories } from "./catalog";
import {
  ActiveConnectorCard,
  ConnectorCatalogCard,
  getCatalogConnector,
  getCatalogStatus,
  getConnectorAccountLabel,
  getConnectorDisplayName,
} from "./components";
import type {
  ConnectorAccountItem,
  ConnectorCatalogItem,
  ConnectorItem,
  ConnectorReadinessState,
  ConnectorWebhookConfig,
  ConnectorWebhookEventItem,
} from "./types";

export type ManageConnectorsTab = "all" | "active";

function connectorCatalogMatches(
  item: ConnectorCatalogItem,
  searchQuery: string,
) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  return [
    item.name,
    item.category,
    item.description,
    item.connectMode,
    ...item.capabilities,
  ].some((value) => value.toLowerCase().includes(q));
}

function connectorMatchesSearch(connector: ConnectorItem, searchQuery: string) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return true;
  return [
    getConnectorDisplayName(connector),
    getConnectorAccountLabel(connector),
    connector.name,
    connector.status,
    connector.meta,
    connector.raw.connectorType,
    connector.raw.lastError ?? "",
  ].some((value) => (value ?? "").toLowerCase().includes(q));
}

export function ManageConnectorsDialog({
  accounts,
  connectorBusyById,
  connectorReadinessById,
  connectors,
  connectorWaitingByType,
  initialTab,
  isLoading,
  loadingError,
  onCancelConnector,
  onConnectConnector,
  onCopyWebhook,
  onCreateConnector,
  onDisconnectConnector,
  onOpenChange,
  onOpenSettings,
  onRequestConnector,
  onSyncConnector,
  onToggleConnectorStatus,
  open,
  webhookConfigsById,
  webhookEventsByConnectorId,
}: {
  accounts: ConnectorAccountItem[];
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  connectors: ConnectorItem[];
  connectorWaitingByType: Record<string, boolean>;
  initialTab: ManageConnectorsTab;
  isLoading: boolean;
  loadingError: string | null;
  onCancelConnector: (item: ConnectorCatalogItem) => void;
  onConnectConnector: (item: ConnectorCatalogItem) => void;
  onCopyWebhook: (value: string) => void;
  onCreateConnector: (item: ConnectorCatalogItem) => void;
  onDisconnectConnector: (connector: ConnectorItem) => void;
  onOpenChange: (open: boolean) => void;
  onOpenSettings: (connector: ConnectorItem) => void;
  onRequestConnector: (item: ConnectorCatalogItem) => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleConnectorStatus: (connector: ConnectorItem) => void;
  open: boolean;
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
  webhookEventsByConnectorId: Record<string, ConnectorWebhookEventItem[]>;
}) {
  const [tab, setTab] = useState<ManageConnectorsTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const activeConnectors = connectors.filter(
    (connector) => connector.status !== "disabled",
  );
  const disabledConnectors = connectors.filter(
    (connector) => connector.status === "disabled",
  );
  const visibleCatalog = connectorCatalog.filter((item) =>
    connectorCatalogMatches(item, searchQuery),
  );
  const visibleManagedConnectors = connectors.filter((connector) =>
    connectorMatchesSearch(connector, searchQuery),
  );
  const filterLabel = tab === "active" ? "Managed" : "All connectors";

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [initialTab, open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid h-[min(860px,calc(100svh-1rem))] w-[min(980px,calc(100vw-1rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        constrainWidth={false}
      >
        <>
          <DialogHeader className="border-b px-4 py-3 pr-11 text-left sm:px-5 sm:py-4 sm:pr-12">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DialogTitle className="text-lg sm:text-xl">
                  Manage Connectors
                </DialogTitle>
                <Badge
                  className="h-5 shrink-0 px-1.5 text-[10px]"
                  variant="secondary"
                >
                  {activeConnectors.length} active
                </Badge>
                {disabledConnectors.length > 0 ? (
                  <Badge
                    className="h-5 shrink-0 px-1.5 text-[10px]"
                    variant="outline"
                  >
                    {disabledConnectors.length} disabled
                  </Badge>
                ) : null}
              </div>
              <DialogDescription className="mt-1 max-w-[680px] text-xs leading-5 sm:text-sm">
                Connect SourceWeft to knowledge, project, and communication
                tools.
              </DialogDescription>
            </div>
            <div className="mt-3 grid min-w-0 gap-2 md:grid-cols-[minmax(0,auto)_minmax(220px,320px)] md:items-center md:justify-between">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="h-9 w-full justify-between gap-2 rounded-lg px-3 text-xs md:w-48"
                    type="button"
                    variant="outline"
                  >
                    <span className="min-w-0 truncate text-left">
                      <span className="text-muted-foreground">Filter:</span>{" "}
                      {filterLabel}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem onSelect={() => setTab("all")}>
                    <CheckCircle2
                      className={cn("size-3.5", tab !== "all" && "opacity-0")}
                    />
                    All connectors
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setTab("active")}>
                    <CheckCircle2
                      className={cn(
                        "size-3.5",
                        tab !== "active" && "opacity-0",
                      )}
                    />
                    Managed
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-9 rounded-lg bg-muted/35 pr-8 pl-8 text-sm"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search connectors"
                  value={searchQuery}
                />
                {searchQuery ? (
                  <button
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearchQuery("")}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          </DialogHeader>

          <ScrollArea className="min-h-0">
            <div className="space-y-4 px-4 py-4 sm:px-5">
              {loadingError ? (
                <Alert variant="destructive">
                  <AlertDescription>{loadingError}</AlertDescription>
                </Alert>
              ) : null}
              {isLoading ? (
                <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading connectors...
                </div>
              ) : null}

              {tab === "all" ? (
                <div className="mt-0 space-y-4">
                  {connectorCatalogCategories.map((category) => {
                    const items = visibleCatalog.filter(
                      (item) => item.category === category,
                    );
                    if (items.length === 0) return null;
                    return (
                      <section className="space-y-2" key={category}>
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-xs font-medium text-muted-foreground">
                            {category}
                          </h3>
                          <span className="text-[10px] text-muted-foreground">
                            {items.length}
                          </span>
                        </div>
                        <div className="grid gap-2.5 lg:grid-cols-2">
                          {items.map((item) => {
                            const connector = getCatalogConnector(
                              item,
                              connectors,
                            );
                            const status = getCatalogStatus({
                              item,
                              connectors,
                              accounts,
                              connectorBusyById,
                              connectorWaitingByType,
                              connectorReadinessById,
                              webhookConfigsById,
                            });
                            return (
                              <ConnectorCatalogCard
                                connector={connector}
                                item={item}
                                key={item.id}
                                onCancelConnector={onCancelConnector}
                                onConfigure={() => {
                                  if (connector) {
                                    onOpenSettings(connector);
                                    return;
                                  }
                                  setTab("active");
                                }}
                                onConnectConnector={onConnectConnector}
                                onCreateConnector={onCreateConnector}
                                onDisconnect={onDisconnectConnector}
                                onRequestConnector={onRequestConnector}
                                status={status}
                              />
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                  {visibleCatalog.length === 0 ? (
                    <HubEmptyState
                      description="Try a different provider, capability, or category."
                      icon={Search}
                      title={`No connectors match "${searchQuery}"`}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="mt-0 space-y-3">
                  {visibleManagedConnectors.length > 0 ? (
                    visibleManagedConnectors.map((connector) => (
                      <ActiveConnectorCard
                        connector={connector}
                        connectorBusyById={connectorBusyById}
                        connectorReadinessById={connectorReadinessById}
                        key={connector.id}
                        onBackToCatalog={() => setTab("all")}
                        onCopyWebhook={onCopyWebhook}
                        onDisconnect={onDisconnectConnector}
                        onOpenSettings={onOpenSettings}
                        onSyncConnector={onSyncConnector}
                        onToggleStatus={onToggleConnectorStatus}
                        webhookConfig={webhookConfigsById[connector.id] ?? null}
                        webhookEvents={
                          webhookEventsByConnectorId[connector.id] ?? []
                        }
                      />
                    ))
                  ) : (
                    <HubEmptyState
                      description={
                        searchQuery
                          ? "Try another connector name or status."
                          : "Connect Notion or choose an upcoming integration from the catalog."
                      }
                      icon={Link2}
                      title={
                        searchQuery
                          ? `No connectors match "${searchQuery}"`
                          : "No connectors yet."
                      }
                    />
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </>
      </DialogContent>
    </Dialog>
  );
}
