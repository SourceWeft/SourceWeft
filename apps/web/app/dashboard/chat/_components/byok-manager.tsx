"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, Loader2, Network, Plus, Trash2 } from "lucide-react";
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
  toCreateByokCredentialPayload,
  type ByokCredentialItem,
  type ByokProviderOption,
  type ByokSavedModelItem,
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
    credentials: ByokCredentialItem[];
    models: ByokSavedModelItem[];
    providers: ByokProviderOption[];
  }) => void;
  open: boolean;
  workspaceId: string | null;
}) {
  const [providers, setProviders] = useState<ByokProviderOption[]>([]);
  const [credentials, setCredentials] = useState<ByokCredentialItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingCredential, setDeletingCredential] = useState<string | null>(null);
  const [providerName, setProviderName] = useState("");
  const [providerKind, setProviderKind] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [credentialAlias, setCredentialAlias] = useState("");
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
        const [providerResult, credentialResult, modelResult] = await Promise.all([
          contentClient.listByokProviders(activeWorkspaceId).catch(() => []),
          contentClient.listByokCredentials(activeWorkspaceId),
          contentClient.listByokModels(activeWorkspaceId),
        ]);
        if (cancelled) {
          return;
        }
        const nextProviders = normalizeByokProviderOptions(
          providerResult,
          credentialResult.items,
        );
        setProviders(nextProviders);
        setCredentials(credentialResult.items);
        onStateChange?.({
          credentials: credentialResult.items,
          models: modelResult.items,
          providers: nextProviders,
        });
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

  const groupedCredentials = useMemo(() => {
    const groups = new Map<string, ByokCredentialItem[]>();
    for (const item of credentials) {
      const group = groups.get(item.providerName) ?? [];
      group.push(item);
      groups.set(item.providerName, group);
    }
    return [...groups.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    );
  }, [credentials]);

  const resetCreateForm = () => {
    setProviderName("");
    setProviderKind("openai-compatible");
    setBaseUrl("");
    setCredentialAlias("");
    setApiKey("");
  };

  const refreshState = async () => {
    if (!workspaceId) {
      return;
    }
    const activeWorkspaceId = workspaceId;
    const [providerResult, credentialResult, modelResult] = await Promise.all([
      contentClient.listByokProviders(activeWorkspaceId).catch(() => []),
      contentClient.listByokCredentials(activeWorkspaceId),
      contentClient.listByokModels(activeWorkspaceId),
    ]);
    const nextProviders = normalizeByokProviderOptions(
      providerResult,
      credentialResult.items,
    );
    setProviders(nextProviders);
    setCredentials(credentialResult.items);
    onStateChange?.({
      credentials: credentialResult.items,
      models: modelResult.items,
      providers: nextProviders,
    });
  };

  const handleCreate = async () => {
    if (!workspaceId) {
      return;
    }
    const activeWorkspaceId = workspaceId;
    if (!providerName.trim() || !credentialAlias.trim() || !apiKey.trim()) {
      toast.error("Provider, credential alias, and API key are required.");
      return;
    }
    setSaving(true);
    try {
      await contentClient.createByokCredential(
        activeWorkspaceId,
        toCreateByokCredentialPayload({
          apiKey,
          baseUrl,
          credentialAlias,
          providerName,
          providerKind,
        }),
      );
      await refreshState();
      resetCreateForm();
      setActiveTab("saved");
      toast.success("BYOK credential saved.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save BYOK credential.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (input: {
    credentialId: string;
    providerName: string;
  }) => {
    if (!workspaceId) {
      return;
    }
    const activeWorkspaceId = workspaceId;
    setDeletingCredential(`${input.providerName}:${input.credentialId}`);
    try {
      await contentClient.deleteByokCredential(
        activeWorkspaceId,
        input.credentialId,
      );
      await refreshState();
      toast.success("BYOK credential deleted.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete BYOK credential.",
      );
    } finally {
      setDeletingCredential(null);
    }
  };

  const providerNames = providers.map((item) => item.providerName);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Manage BYOK Providers
          </DialogTitle>
          <DialogDescription>
            Save provider credentials once, then reuse them from the chat model selector.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          className="flex min-h-0 flex-1 flex-col"
          onValueChange={setActiveTab}
          value={activeTab}
        >
          <div className="px-6 pt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="saved">Credentials</TabsTrigger>
              <TabsTrigger value="add">Add credential</TabsTrigger>
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
              ) : groupedCredentials.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
                  No BYOK credentials yet. Add one to unlock provider-backed chat runs.
                </div>
              ) : (
                <div className="space-y-3">
                  {groupedCredentials.map(([groupName, items]) => {
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
                              deletingCredential === `${item.providerName}:${item.id}`;
                            return (
                              <div
                                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2"
                                key={item.id}
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-foreground">
                                    {item.credentialAlias}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    Updated {new Date(item.updatedAt).toLocaleString()}
                                  </div>
                                </div>
                                <Button
                                  disabled={busy}
                                  onClick={() =>
                                    void handleDelete({
                                      credentialId: item.id,
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
            <div className="mt-4 grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
              <section className="rounded-2xl border border-border/70 bg-muted/15 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Network className="size-4 text-muted-foreground" />
                  Provider
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Pick an existing provider or define a compatible endpoint.
                </div>

                {providerNames.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      Known providers
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {providerNames.slice(0, 10).map((name) => (
                        <button
                          className={
                            providerName === name
                              ? "rounded-full border border-foreground bg-foreground px-2.5 py-1 text-xs font-medium text-background"
                              : "rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/40"
                          }
                          key={name}
                          onClick={() => setProviderName(name)}
                          type="button"
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 space-y-2">
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

                <div className="mt-4 space-y-2">
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

                <div className="mt-4 space-y-2">
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
              </section>

              <section className="flex min-h-[420px] flex-col rounded-2xl border border-border/70 bg-background/80 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <KeyRound className="size-4 text-muted-foreground" />
                  Model access
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Save the credential once, then choose provider on the left and model on the right inside chat.
                </div>

                <div className="mt-4 space-y-2">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="byok-credential-alias">
                    Credential alias
                  </label>
                  <Input
                    id="byok-credential-alias"
                    onChange={(event) => setCredentialAlias(event.target.value)}
                    placeholder="personal-openai"
                    value={credentialAlias}
                  />
                </div>

                <div className="mt-4 space-y-2">
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

                <div className="mt-4 rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Leave Base URL empty to use the system default endpoint for that provider. Add one for a custom OpenAI-compatible, Anthropic, Gemini, or proxy endpoint.
                </div>

                <div className="mt-auto flex justify-end gap-2 pt-6">
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
                    Save credential
                  </Button>
                </div>
              </section>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
