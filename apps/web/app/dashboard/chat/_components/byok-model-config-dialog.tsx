"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { contentClient } from "../../../../lib/sdk";
import {
  createCustomModelItem,
  normalizeProviderSlug,
  toProviderLabel,
  type ModelThinkingCapabilities,
  type ModelItem,
  type ModelType,
} from "./model-catalog-utils";
import {
  DEFAULT_BYOK_PROVIDER_KIND,
  normalizeByokProviderOptions,
  toByokSelectionFromCustomModel,
  toCreateByokCredentialPayload,
  type ByokCredentialItem,
  type ByokModelSelection,
  type ByokProviderOption,
  type ByokSavedModelItem,
} from "./byok-state";

const CUSTOM_PROVIDER_NAME = "custom";

const modelTypeLabels: Record<ModelType, string> = {
  image: "Image",
  llm: "LLM",
  vision: "Vision",
};

function getProviderLabel(providerName: string) {
  return providerName === CUSTOM_PROVIDER_NAME
    ? "Custom Provider"
    : toProviderLabel(providerName);
}

export type ByokModelConfigDefaults = {
  credentialId?: string;
  providerKind?: string;
  providerName?: string;
  type: ModelType;
};

function buildProviderOptions(providers: ByokProviderOption[]) {
  const seen = new Set<string>();
  const options: ByokProviderOption[] = [];

  for (const provider of providers) {
    const providerName = provider.providerName.trim();
    if (
      !provider.system ||
      !providerName ||
      providerName === CUSTOM_PROVIDER_NAME ||
      seen.has(providerName)
    ) {
      continue;
    }
    options.push(provider);
    seen.add(providerName);
  }

  const existingCustom = providers.find(
    (provider) => provider.providerName === CUSTOM_PROVIDER_NAME,
  );
  options.push({
    baseUrl: existingCustom?.baseUrl ?? null,
    hasApiKey: existingCustom?.hasApiKey ?? false,
    isByokOnly: true,
    providerKind: DEFAULT_BYOK_PROVIDER_KIND,
    providerName: CUSTOM_PROVIDER_NAME,
    system: false,
  });

  return options;
}

function resolveInitialProviderName(input: {
  defaults: ByokModelConfigDefaults | null;
  providerOptions: ByokProviderOption[];
}) {
  const requested = input.defaults?.providerName?.trim();
  if (
    requested &&
    input.providerOptions.some(
      (provider) => provider.providerName === requested && provider.system,
    )
  ) {
    return requested;
  }
  if (requested === CUSTOM_PROVIDER_NAME) {
    return CUSTOM_PROVIDER_NAME;
  }
  if (requested) {
    return CUSTOM_PROVIDER_NAME;
  }
  return input.providerOptions[0]?.providerName ?? CUSTOM_PROVIDER_NAME;
}

export function ByokModelConfigDialog({
  defaults,
  onConfigured,
  onOpenChange,
  onStateChange,
  open,
  credentials,
  providers,
  workspaceId,
}: {
  defaults: ByokModelConfigDefaults | null;
  onConfigured: (input: {
    model?: ModelItem;
    selection?: ByokModelSelection;
    type: ModelType;
  }) => void;
  onOpenChange: (open: boolean) => void;
  onStateChange?: (input: {
    credentials: ByokCredentialItem[];
    models: ByokSavedModelItem[];
    providers: ByokProviderOption[];
  }) => void;
  open: boolean;
  credentials: ByokCredentialItem[];
  providers: ByokProviderOption[];
  workspaceId: string | null;
}) {
  const type = defaults?.type ?? "llm";
  const providerOptions = useMemo(() => buildProviderOptions(providers), [providers]);
  const [providerName, setProviderName] = useState(CUSTOM_PROVIDER_NAME);
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [credentialAlias, setCredentialAlias] = useState("");
  const [credentialMode, setCredentialMode] = useState<"existing" | "new">("new");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedProvider =
    providerOptions.find((provider) => provider.providerName === providerName) ??
    providerOptions[0] ??
    null;
  const isCustomProvider = providerName === CUSTOM_PROVIDER_NAME;
  const effectiveProviderKind = isCustomProvider
    ? DEFAULT_BYOK_PROVIDER_KIND
    : selectedProvider?.providerKind || DEFAULT_BYOK_PROVIDER_KIND;
  const effectiveBaseUrl = isCustomProvider
    ? baseUrl
    : selectedProvider?.baseUrl ?? "";
  const providerCredentials = useMemo(
    () => credentials.filter((item) => item.providerName === providerName),
    [credentials, providerName],
  );
  const selectedCredential = providerCredentials.find(
    (item) => item.id === credentialId,
  );
  const requiresNewCredential = credentialMode === "new" || providerCredentials.length === 0;
  const canSubmit =
    providerName.trim().length > 0 &&
    (requiresNewCredential
      ? credentialAlias.trim().length > 0
      : credentialId.trim().length > 0) &&
    modelName.trim().length > 0 &&
    displayName.trim().length > 0 &&
    (!requiresNewCredential || apiKey.trim().length > 0) &&
    (!requiresNewCredential || !isCustomProvider || baseUrl.trim().length > 0);

  useEffect(() => {
    if (!open) {
      return;
    }
    const nextProviderName = resolveInitialProviderName({
      defaults,
      providerOptions,
    });
    const nextProvider =
      providerOptions.find((provider) => provider.providerName === nextProviderName) ??
      null;

    setProviderName(nextProviderName);
    setBaseUrl(
      nextProviderName === CUSTOM_PROVIDER_NAME ? (nextProvider?.baseUrl ?? "") : "",
    );
    setModelName("");
    setDisplayName("");
    const defaultCredentialId = defaults?.credentialId?.trim() ?? "";
    setCredentialId(defaultCredentialId);
    setCredentialAlias(defaultCredentialId ? "" : "default");
    setCredentialMode(defaultCredentialId ? "existing" : "new");
    setApiKey("");
  }, [defaults, open, providerOptions]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const firstCredential = providerCredentials[0] ?? null;
    if (providerCredentials.length === 0) {
      if (credentialMode !== "new") {
        setCredentialMode("new");
      }
      setCredentialAlias((current) => current || "default");
      return;
    }
    if (credentialMode === "new") {
      return;
    }
    if (
      !credentialId ||
      !providerCredentials.some((item) => item.id === credentialId)
    ) {
      if (credentialMode !== "existing") {
        setCredentialMode("existing");
      }
      const nextCredentialId = firstCredential?.id ?? "";
      if (credentialId !== nextCredentialId) {
        setCredentialId(nextCredentialId);
      }
    }
  }, [credentialId, credentialMode, open, providerCredentials]);

  const refreshByokState = async () => {
    if (!workspaceId) {
      return;
    }
    const [providerResult, credentialResult, modelResult] = await Promise.all([
      contentClient.listByokProviders(workspaceId).catch(() => []),
      contentClient.listByokCredentials(workspaceId),
      contentClient.listByokModels(workspaceId),
    ]);
    onStateChange?.({
      credentials: credentialResult.items,
      models: modelResult.items,
      providers: normalizeByokProviderOptions(
        providerResult,
        credentialResult.items,
      ),
    });
  };

  const handleSubmit = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!workspaceId || !canSubmit) {
      return;
    }

    const trimmedProviderName = providerName.trim();
    const trimmedCredentialAlias = credentialAlias.trim();
    const trimmedModelName = modelName.trim();
    const trimmedDisplayName = displayName.trim();
    const trimmedBaseUrl = baseUrl.trim();
    setSaving(true);
    try {
      let activeCredentialId = credentialId;
      let activeCredentialAlias =
        selectedCredential?.credentialAlias ?? trimmedCredentialAlias;
      if (requiresNewCredential) {
        const created = await contentClient.createByokCredential(
          workspaceId,
          toCreateByokCredentialPayload({
            apiKey,
            baseUrl: isCustomProvider ? trimmedBaseUrl : "",
            credentialAlias: trimmedCredentialAlias,
            providerKind: effectiveProviderKind,
            providerName: trimmedProviderName,
          }),
        );
        activeCredentialId = created.item.id;
        activeCredentialAlias = created.item.credentialAlias;
      }

      const createdModel = await contentClient.addByokModel(workspaceId, {
        credentialId: activeCredentialId,
        displayName: trimmedDisplayName,
        modelName: trimmedModelName,
        modelType: type,
      });

      await refreshByokState();
      const providerSlug = normalizeProviderSlug(trimmedProviderName);
      const providerLabel = getProviderLabel(trimmedProviderName);
      const selection = toByokSelectionFromCustomModel({
        byokModelId: createdModel.item.id,
        capabilities: createdModel.item.capabilities as ModelThinkingCapabilities | null,
        credentialAlias: activeCredentialAlias,
        credentialId: activeCredentialId,
        modelName: trimmedModelName,
        providerName: trimmedProviderName,
      });
      const model = createCustomModelItem({
        byokCredentialId: activeCredentialId,
        byokCredentialAlias: activeCredentialAlias,
        byokModelId: createdModel.item.id,
        capabilities: createdModel.item.capabilities as ModelThinkingCapabilities | null,
        modelAlias: trimmedModelName,
        name: trimmedDisplayName,
        providerLabel,
        providerSlug,
        subtitle: `${trimmedModelName} via ${providerLabel} BYOK`,
      });

      onConfigured({ model, selection, type });
      onOpenChange(false);
      toast.success("BYOK model configured.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to configure BYOK model.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] w-[520px] max-w-[calc(100%-2rem)] overflow-y-auto"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>Add New Configuration</DialogTitle>
          <DialogDescription>
            Set up a new {modelTypeLabels[type].toLowerCase()} BYOK model.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          id="byok-model-config-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className="space-y-4">
            <div className="text-xs font-medium text-muted-foreground sm:text-sm">
              Model Configuration
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <label
                  className="text-xs font-medium sm:text-sm"
                  htmlFor="byok-model-provider"
                >
                  Provider
                </label>
                <Select
                  disabled={saving}
                  onValueChange={setProviderName}
                  value={providerName}
                >
                  <SelectTrigger className="h-9 w-full rounded-md">
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {providerOptions.map((provider) => (
                      <SelectItem
                        key={provider.providerName}
                        value={provider.providerName}
                      >
                        {getProviderLabel(provider.providerName)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <label
                  className="text-xs font-medium sm:text-sm"
                  htmlFor="byok-model-name"
                >
                  Model ID
                </label>
                <Input
                  disabled={saving}
                  id="byok-model-name"
                  onChange={(event) => setModelName(event.target.value)}
                  placeholder="openai/gpt-oss-120b:free"
                  value={modelName}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <label
                className="text-xs font-medium sm:text-sm"
                htmlFor="byok-model-display-name"
              >
                Display Name
              </label>
              <Input
                disabled={saving}
                id="byok-model-display-name"
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="GPT OSS 120B Free"
                value={displayName}
              />
            </div>

            <div className="grid gap-2">
              <label
                className="text-xs font-medium sm:text-sm"
                htmlFor="byok-model-credential-alias"
              >
                Saved credential
              </label>
              {providerCredentials.length > 0 && credentialMode === "existing" ? (
                <Select
                  disabled={saving}
                  onValueChange={setCredentialId}
                  value={credentialId}
                >
                  <SelectTrigger className="h-9 w-full rounded-md">
                    <SelectValue placeholder="Select a saved credential" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {providerCredentials.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.credentialAlias}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  disabled={saving}
                  id="byok-model-credential-alias"
                  onChange={(event) => setCredentialAlias(event.target.value)}
                  placeholder="default"
                  value={credentialAlias}
                />
              )}
              <p className="text-[10px] text-muted-foreground sm:text-xs">
                The credential alias identifies the saved API key. Models are stored under this credential.
              </p>
              {providerCredentials.length > 0 ? (
                <Button
                  className="h-auto justify-start px-0 text-xs"
                  disabled={saving}
                  onClick={() => {
                    const nextMode =
                      credentialMode === "existing" ? "new" : "existing";
                    setCredentialMode(nextMode);
                    if (nextMode === "new") {
                      setCredentialAlias("default");
                      setCredentialId("");
                    } else {
                      setCredentialAlias("");
                      setCredentialId(providerCredentials[0]?.id ?? "");
                    }
                  }}
                  type="button"
                  variant="link"
                >
                  {credentialMode === "existing"
                    ? "Use a new API key instead"
                    : "Use an existing saved credential"}
                </Button>
              ) : null}
            </div>

            {requiresNewCredential ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label
                    className="text-xs font-medium sm:text-sm"
                    htmlFor="byok-model-api-key"
                  >
                    API Key
                  </label>
                  <Input
                    disabled={saving}
                    id="byok-model-api-key"
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-..."
                    type="password"
                    value={apiKey}
                  />
                </div>

                <div className="grid gap-2">
                  <label
                    className="text-xs font-medium sm:text-sm"
                    htmlFor="byok-model-base-url"
                  >
                    API Base URL
                  </label>
                  <Input
                    disabled={!isCustomProvider || saving}
                    id="byok-model-base-url"
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder={
                      isCustomProvider
                        ? "https://api.example.com/v1"
                        : "System default"
                    }
                    value={effectiveBaseUrl}
                  />
                </div>
              </div>
            ) : null}

            {isCustomProvider ? (
              <p className="text-[10px] text-muted-foreground sm:text-xs">
                OpenAI-compatible providers and private proxies are configured
                under Custom Provider.
              </p>
            ) : null}
          </div>
        </form>

        <DialogFooter>
          <Button
            disabled={saving}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            className="min-w-[120px]"
            disabled={!canSubmit || saving}
            form="byok-model-config-form"
            type="submit"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Add Model"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
