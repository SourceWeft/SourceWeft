import {
  Link2,
  Loader2,
  Play,
  PowerOff,
  RotateCcw,
  Settings2,
} from "lucide-react";

import {
  Alert,
  AlertDescription,
} from "@sourceweft/ui-web/components/ui/alert";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";

import { HubEmptyState } from "../components/hub-empty-state";
import { connectorCatalog } from "./catalog";
import {
  ConnectorLogo,
  compactConnectorProviderMeta,
  disabledConnectorIconButtonClass,
  formatConnectorReadinessSummary,
  getConnectorDisplayName,
} from "./components";
import type {
  ConnectorItem,
  ConnectorReadinessState,
  ConnectorWebhookConfig,
} from "./types";

export function ConnectorsTab({
  connectors,
  connectorBusyById,
  connectorReadinessById,
  isLoading,
  loadingError,
  onConfigureConnector,
  onManageConnectors,
  onSyncConnector,
  onToggleConnectorStatus,
}: {
  connectors: ConnectorItem[];
  connectorBusyById: Record<string, boolean>;
  connectorReadinessById: Record<string, ConnectorReadinessState>;
  isLoading: boolean;
  loadingError: string | null;
  onConfigureConnector: (connector: ConnectorItem) => void;
  onManageConnectors: () => void;
  onSyncConnector: (connector: ConnectorItem) => void;
  onToggleConnectorStatus: (connector: ConnectorItem) => void;
  webhookConfigsById: Record<string, ConnectorWebhookConfig | null>;
}) {
  const activeConnectors = connectors.filter(
    (connector) => connector.status !== "disabled",
  );
  return (
    <section className="space-y-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-foreground">Connectors</h3>
          <span className="text-[10px] text-muted-foreground">
            {activeConnectors.length} active
          </span>
        </div>
        <Button
          disabled={isLoading}
          onClick={onManageConnectors}
          size="xs"
          type="button"
          variant="outline"
        >
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Settings2 className="size-3.5" />
          )}
          Manage
        </Button>
      </div>

      {loadingError ? (
        <Alert className="mb-2" variant="destructive">
          <AlertDescription>{loadingError}</AlertDescription>
        </Alert>
      ) : null}

      {activeConnectors.length > 0 ? (
        <div className="space-y-1.5">
          {activeConnectors.map((connector) => {
            const isBusy = Boolean(connectorBusyById[connector.id]);
            const readiness = connectorReadinessById[connector.id] ?? null;
            const providerName = getConnectorDisplayName(connector);
            const catalogItem = connectorCatalog.find(
              (item) => item.id === connector.raw.connectorType,
            );
            const subtitle =
              formatConnectorReadinessSummary(readiness) ??
              compactConnectorProviderMeta(connector);
            return (
              <div
                className="rounded-lg border bg-background p-2 text-xs"
                key={connector.id}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ConnectorLogo
                    active={connector.status === "active"}
                    className="size-8"
                    icon={catalogItem?.icon ?? Link2}
                    label={providerName}
                    logoIconName={catalogItem?.logoIconName}
                    logoIconTone={catalogItem?.logoIconTone}
                    logoSrc={catalogItem?.logoSrc}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <button
                        className="min-w-0 truncate text-left font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        onClick={() => onConfigureConnector(connector)}
                        title={`Open ${providerName} settings`}
                        type="button"
                      >
                        {providerName}
                      </button>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {connector.status}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {subtitle}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      className={cn("size-7", disabledConnectorIconButtonClass)}
                      disabled={connector.status === "disabled" || isBusy}
                      onClick={() => onSyncConnector(connector)}
                      size="icon-xs"
                      title={
                        connector.status === "paused"
                          ? `Sync paused ${providerName} manually`
                          : connector.status === "disabled"
                            ? `${providerName} is disabled`
                            : `Sync ${providerName}`
                      }
                      type="button"
                      variant="ghost"
                    >
                      {isBusy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      <span className="sr-only">Sync {providerName}</span>
                    </Button>
                    <Button
                      className="size-7"
                      onClick={() => onConfigureConnector(connector)}
                      size="icon-xs"
                      title={`Open ${providerName} settings`}
                      type="button"
                      variant="ghost"
                    >
                      <Settings2 className="size-3.5" />
                      <span className="sr-only">Configure {providerName}</span>
                    </Button>
                    <Button
                      className={cn("size-7", disabledConnectorIconButtonClass)}
                      disabled={isBusy}
                      onClick={() => onToggleConnectorStatus(connector)}
                      size="icon-xs"
                      title={
                        connector.status === "paused"
                          ? `Resume ${providerName}`
                          : `Pause ${providerName}`
                      }
                      type="button"
                      variant="ghost"
                    >
                      {connector.status === "paused" ? (
                        <Play className="size-3.5" />
                      ) : (
                        <PowerOff className="size-3.5" />
                      )}
                      <span className="sr-only">
                        {connector.status === "paused" ? "Resume" : "Pause"}{" "}
                        {providerName}
                      </span>
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <HubEmptyState
          description="Open the catalog to connect Notion or preview upcoming integrations."
          icon={Link2}
          title="No active connectors yet."
        />
      )}
    </section>
  );
}
