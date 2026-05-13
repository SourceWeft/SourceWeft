"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@sourceweft/ui-web/components/ui/alert";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sourceweft/ui-web/components/ui/tabs";
import { contentClient } from "../../../../lib/sdk";
import {
  normalizeByokProviderOptions,
  toCreateByokKeyPayload,
  type ByokKeyRefItem,
  type ByokProviderOption,
} from "./byok-state";

function providerKindLabel(value: string) {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function ByokManagerDialog({
  onOpenChange,
  onStateChange,
  open,
  workspaceId,
}: {
  onOpenChange: (open: boolean) => void;
  onStateChange?: (input: {
    keyRefs: ByokKeyRefItem[];
    providers: ByokProviderOption[];
  }) => void;
  open: boolean;
  workspaceId: string | null;
}) {
  const [providers, setProviders] = useState<ByokProviderOption[]>([]);
  const [keyRefs, setKeyRefs] = useState<ByokKeyRefItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [providerName, setProviderName] = useState("");
  const [providerKind, setProviderKind] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [keyRef, setKeyRef] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [activeTab, setActiveTab] = useState("saved");

  useEffect(() => {
    if (!open || !workspaceId) {
      return;
    }
    const activeWorkspaceId = workspaceId;

    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const [providerResult, keyResult] = await Promise.all([
          contentClient.listByokProviders(activeWorkspaceId).catch(() => []),
          contentClient.listByokKeyRefs(activeWorkspaceId),
        ]);
        if (cancelled) {
          return;
        }
        const nextProviders = normalizeByokProviderOptions(
          providerResult,
          keyResult.items,
        );
        setProviders(nextProviders);
        setKeyRefs(keyResult.items);
        onStateChange?.({ keyRefs: keyResult.items, providers: nextProviders });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setLoadError(
          error instanceof Error ? error.message : "Failed to load BYOK providers.",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [onStateChange, open, workspaceId]);

  const groupedKeyRefs = useMemo(() => {
    const groups = new Map<string, ByokKeyRefItem[]>();
    for (const item of keyRefs) {
      const group = groups.get(item.providerName) ?? [];
      group.push(item);
      groups.set(item.providerName, group);
    }
    return [...groups.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    );
  }, [keyRefs]);

  const resetCreateForm = () => {
    setProviderName("");
    setProviderKind("openai-compatible");
    setBaseUrl("");
    setKeyRef("");
    setApiKey("");
  };

  const refreshState = async () => {
    if (!workspaceId) {
      return;
    }
    const activeWorkspaceId = workspaceId;
    const [providerResult, keyResult] = await Promise.all([
      contentClient.listByokProviders(activeWorkspaceId).catch(() => []),
      contentClient.listByokKeyRefs(activeWorkspaceId),
    ]);
    const nextProviders = normalizeByokProviderOptions(providerResult, keyResult.items);
    setProviders(nextProviders);
    setKeyRefs(keyResult.items);
    onStateChange?.({ keyRefs: keyResult.items, providers: nextProviders });
  };

  const handleCreate = async () => {
    if (!workspaceId) {
      return;
    }
    const activeWorkspaceId = workspaceId;
    if (!providerName.trim() || !keyRef.trim() || !apiKey.trim()) {
      toast.error("Provider, key ref, and API key are required.");
      return;
    }
    setSaving(true);
    try {
      await contentClient.createByokKeyRef(
        activeWorkspaceId,
        toCreateByokKeyPayload({
          apiKey,
          baseUrl,
          keyRef,
          providerName,
          providerKind,
        }),
      );
      await refreshState();
      resetCreateForm();
      setActiveTab("saved");
      toast.success("BYOK key saved.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save BYOK key.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (input: {
    keyRef: string;
    providerName: string;
  }) => {
    if (!workspaceId) {
      return;
    }
    const activeWorkspaceId = workspaceId;
    setDeletingKey(`${input.providerName}:${input.keyRef}`);
    try {
      await contentClient.deleteByokKeyRef(
        activeWorkspaceId,
        input.providerName,
        input.keyRef,
      );
      await refreshState();
      toast.success("BYOK key deleted.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete BYOK key.",
      );
    } finally {
      setDeletingKey(null);
    }
  };

  const providerNames = providers.map((item) => item.providerName);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Manage BYOK Providers
          </DialogTitle>
          <DialogDescription>
            Save provider keys once, then reuse them from the chat model selector.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          className="flex min-h-0 flex-1 flex-col"
          onValueChange={setActiveTab}
          value={activeTab}
        >
          <div className="px-6 pt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="saved">Saved keys</TabsTrigger>
              <TabsTrigger value="add">Add key</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent className="min-h-0 flex-1 px-6 pb-6" value="saved">
            {loadError ? (
              <Alert className="mt-4" variant="destructive">
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            ) : null}

            <ScrollArea className="mt-4 h-[52vh] pr-3">
              {loading ? (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Loading BYOK configuration...
                </div>
              ) : groupedKeyRefs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
                  No saved BYOK keys yet. Add one to unlock provider-backed chat runs.
                </div>
              ) : (
                <div className="space-y-3">
                  {groupedKeyRefs.map(([groupName, items]) => {
                    const provider =
                      providers.find((entry) => entry.providerName === groupName) ??
                      null;
                    return (
                      <section
                        className="rounded-2xl border border-border/70 bg-background/80 p-4"
                        key={groupName}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-foreground">
                            {groupName}
                          </h3>
                          {provider ? (
                            <Badge variant="outline">
                              {providerKindLabel(provider.providerKind)}
                            </Badge>
                          ) : null}
                          {provider?.system ? (
                            <Badge variant="secondary">System provider</Badge>
                          ) : (
                            <Badge variant="secondary">Custom provider</Badge>
                          )}
                          {provider?.baseUrl ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {provider.baseUrl}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-3 space-y-2">
                          {items.map((item) => {
                            const busy =
                              deletingKey === `${item.providerName}:${item.keyRef}`;
                            return (
                              <div
                                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2"
                                key={item.id}
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-foreground">
                                    {item.keyRef}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    Updated {new Date(item.updatedAt).toLocaleString()}
                                  </div>
                                </div>
                                <Button
                                  disabled={busy}
                                  onClick={() =>
                                    void handleDelete({
                                      keyRef: item.keyRef,
                                      providerName: item.providerName,
                                    })
                                  }
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  {busy ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="size-4" />
                                  )}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent className="px-6 pb-6" value="add">
            <div className="mt-4 space-y-4 rounded-2xl border border-border/70 bg-background/80 p-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="byok-provider">
                  Provider name
                </label>
                <Input
                  id="byok-provider"
                  list="byok-provider-suggestions"
                  onChange={(event) => setProviderName(event.target.value)}
                  placeholder="openai, anthropic, deepseek, my-proxy"
                  value={providerName}
                />
                <datalist id="byok-provider-suggestions">
                  {providerNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="byok-key-ref">
                  Key reference
                </label>
                <Input
                  id="byok-key-ref"
                  onChange={(event) => setKeyRef(event.target.value)}
                  placeholder="personal-openai"
                  value={keyRef}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="byok-provider-kind">
                  Provider kind
                </label>
                <Input
                  id="byok-provider-kind"
                  onChange={(event) => setProviderKind(event.target.value)}
                  placeholder="openai-compatible"
                  value={providerKind}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="byok-base-url">
                  Base URL
                </label>
                <Input
                  id="byok-base-url"
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://my-proxy.example.com/v1"
                  value={baseUrl}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="byok-api-key">
                  API key
                </label>
                <Input
                  id="byok-api-key"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-..."
                  type="password"
                  value={apiKey}
                />
              </div>

              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Leave Base URL empty to use the system default endpoint for that provider. Add one when you want a custom BYOK-compatible endpoint.
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => {
                    resetCreateForm();
                    setActiveTab("saved");
                  }}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button disabled={saving} onClick={() => void handleCreate()} type="button">
                  {saving ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 size-4" />
                  )}
                  Save key
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
