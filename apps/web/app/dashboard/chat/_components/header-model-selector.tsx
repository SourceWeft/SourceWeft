"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import {
  ChevronDown,
  Eye,
  Image as ImageIcon,
  Zap,
} from "lucide-react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@sourceweft/ui-web/components/ai-elements/model-selector";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sourceweft/ui-web/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sourceweft/ui-web/components/ui/tooltip";

export type ModelType = "llm" | "image" | "vision";

export type ModelItem = {
  chef: string;
  chefSlug: string;
  id: string;
  name: string;
  provider: string;
  subtitle: string;
  badges?: string[];
};

const llmModels = [
  {
    chef: "Anthropic",
    chefSlug: "anthropic",
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "anthropic" as const,
    subtitle: "claude-sonnet-4-20250514",
    badges: ["Citations"],
  },
  {
    chef: "Anthropic",
    chefSlug: "anthropic",
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    provider: "anthropic" as const,
    subtitle: "claude-opus-4-20250514",
    badges: ["Reasoning"],
  },
  {
    chef: "Anthropic",
    chefSlug: "anthropic",
    id: "claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    provider: "anthropic" as const,
    subtitle: "claude-3.5-haiku",
  },
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai" as const,
    subtitle: "gpt-4o",
    badges: ["Fast"],
  },
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai" as const,
    subtitle: "gpt-4.1",
    badges: ["Stable"],
  },
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "o1-mini",
    name: "o1 Mini",
    provider: "openai" as const,
    subtitle: "o1-mini",
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google" as const,
    subtitle: "gemini-2.5-pro",
    badges: ["Large Context"],
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google" as const,
    subtitle: "gemini-2.5-flash",
    badges: ["Fast"],
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    provider: "google" as const,
    subtitle: "gemini-1.5-pro",
  },
  {
    chef: "DeepSeek",
    chefSlug: "deepseek",
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek" as const,
    subtitle: "deepseek-chat",
  },
  {
    chef: "DeepSeek",
    chefSlug: "deepseek",
    id: "deepseek-r1",
    name: "DeepSeek R1",
    provider: "deepseek" as const,
    subtitle: "deepseek-r1",
    badges: ["Reasoning"],
  },
  {
    chef: "DeepSeek",
    chefSlug: "deepseek",
    id: "deepseek-v3",
    name: "DeepSeek V3",
    provider: "deepseek" as const,
    subtitle: "deepseek-v3",
  },
];

const imageModels = [
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "dall-e-3",
    name: "DALL-E 3",
    provider: "openai" as const,
    subtitle: "dall-e-3",
  },
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "gpt-image-1",
    name: "GPT Image 1",
    provider: "openai" as const,
    subtitle: "gpt-image-1",
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "imagen-3",
    name: "Imagen 3",
    provider: "google" as const,
    subtitle: "imagen-3",
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "imagen-2",
    name: "Imagen 2",
    provider: "google" as const,
    subtitle: "imagen-2",
  },
  {
    chef: "xAI",
    chefSlug: "xai",
    id: "grok-2-image",
    name: "Grok 2 Image",
    provider: "xai" as const,
    subtitle: "grok-2-image",
  },
  {
    chef: "xAI",
    chefSlug: "xai",
    id: "grok-vision-image",
    name: "Grok Vision Image",
    provider: "xai" as const,
    subtitle: "grok-vision-image",
  },
  {
    chef: "Stability",
    chefSlug: "deepinfra",
    id: "stable-diffusion-3",
    name: "Stable Diffusion 3",
    provider: "deepinfra" as const,
    subtitle: "stable-diffusion-3",
  },
  {
    chef: "Stability",
    chefSlug: "deepinfra",
    id: "flux-1-pro",
    name: "FLUX.1 Pro",
    provider: "deepinfra" as const,
    subtitle: "flux-1-pro",
  },
];

const visionModels = [
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "gpt-4.1-vision",
    name: "GPT-4.1 Vision",
    provider: "openai" as const,
    subtitle: "gpt-4.1-vision",
    badges: ["Clipboard"],
  },
  {
    chef: "OpenAI",
    chefSlug: "openai",
    id: "gpt-4o-vision",
    name: "GPT-4o Vision",
    provider: "openai" as const,
    subtitle: "gpt-4o-vision",
  },
  {
    chef: "Anthropic",
    chefSlug: "anthropic",
    id: "claude-3.7-sonnet-vision",
    name: "Claude 3.7 Vision",
    provider: "anthropic" as const,
    subtitle: "claude-3.7-sonnet-vision",
  },
  {
    chef: "Anthropic",
    chefSlug: "anthropic",
    id: "claude-sonnet-4-vision",
    name: "Claude Sonnet 4 Vision",
    provider: "anthropic" as const,
    subtitle: "claude-sonnet-4-vision",
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "gemini-2.5-flash-vision",
    name: "Gemini 2.5 Flash Vision",
    provider: "google" as const,
    subtitle: "gemini-2.5-flash-vision",
  },
  {
    chef: "Google",
    chefSlug: "google",
    id: "gemini-1.5-pro-vision",
    name: "Gemini 1.5 Pro Vision",
    provider: "google" as const,
    subtitle: "gemini-1.5-pro-vision",
  },
  {
    chef: "Meta",
    chefSlug: "llama",
    id: "llama-4-maverick-vision",
    name: "Llama 4 Maverick Vision",
    provider: "llama" as const,
    subtitle: "llama-4-maverick-vision",
  },
  {
    chef: "Meta",
    chefSlug: "llama",
    id: "llama-3.2-vision",
    name: "Llama 3.2 Vision",
    provider: "llama" as const,
    subtitle: "llama-3.2-vision",
  },
];

export const allModels: Record<ModelType, ModelItem[]> = {
  image: imageModels,
  llm: llmModels,
  vision: visionModels,
};

const modelTypeLabels: Record<ModelType, string> = {
  image: "Image",
  llm: "LLM",
  vision: "Vision",
};

function ModelTypeIcon({ type }: { type: ModelType }) {
  if (type === "llm") {
    return <Zap className="size-3.5" />;
  }
  if (type === "image") {
    return <ImageIcon className="size-3.5" />;
  }
  return <Eye className="size-3.5" />;
}

function SelectorPanel({
  activeTab,
  selectedModels,
  setActiveTab,
  setOpen,
  setSelectedModels,
}: {
  activeTab: ModelType;
  selectedModels: Record<ModelType, ModelItem>;
  setActiveTab: Dispatch<SetStateAction<ModelType>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedModels: Dispatch<SetStateAction<Record<ModelType, ModelItem>>>;
}) {
  const chefs = [
    ...new Set(allModels[activeTab].map((model) => model.chef)),
  ];

  return (
    <Tabs
      className="w-full gap-0"
      onValueChange={(value) => setActiveTab(value as ModelType)}
      value={activeTab}
    >
      <div>
        <TabsList
          className="grid h-11 w-full grid-cols-3 rounded-none bg-transparent px-1 pt-1"
          variant="line"
        >
          {(["llm", "image", "vision"] as ModelType[]).map((type) => (
            <TabsTrigger
              className="h-full rounded-t-md border-b border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground data-active:border-foreground data-active:bg-transparent data-active:text-foreground data-active:shadow-none"
              key={type}
              value={type}
            >
              <ModelTypeIcon type={type} />
              {modelTypeLabels[type]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {(["llm", "image", "vision"] as ModelType[]).map((type) => (
        <TabsContent className="mt-0" key={type} value={type}>
          <div className="px-2 pt-2.5 pb-1.5">
            <ModelSelectorInput placeholder="Search models..." />
          </div>
          <ModelSelectorList className="max-h-[360px] overflow-y-auto">
            <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
            {chefs.map((chef) => (
              <ModelSelectorGroup heading={chef} key={chef}>
                {allModels[type]
                  .filter((model) => model.chef === chef)
                  .map((model) => {
                    const selected = selectedModels[type].id === model.id;

                    return (
                      <ModelSelectorItem
                        data-checked={selected ? true : undefined}
                        key={model.id}
                        onSelect={() => {
                          setSelectedModels((current) => ({
                            ...current,
                            [type]: model,
                          }));
                          setOpen(false);
                        }}
                        value={`${model.name} ${model.subtitle} ${model.provider} ${model.chef}`}
                      >
                        <ModelSelectorLogo provider={model.chefSlug} />
                        <ModelSelectorName>{model.name}</ModelSelectorName>
                        {model.badges?.map((badge) => (
                          <Badge
                            className="h-4 rounded-md px-1.5 text-[9px]"
                            key={badge}
                            variant="outline"
                          >
                            {badge}
                          </Badge>
                        ))}
                      </ModelSelectorItem>
                    );
                  })}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function HeaderModelSelector({
  selectedModels,
  setSelectedModels,
}: {
  selectedModels: Record<ModelType, ModelItem>;
  setSelectedModels: Dispatch<SetStateAction<Record<ModelType, ModelItem>>>;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ModelType>("llm");

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-background px-1 py-0.5 shadow-xs">
          {(["llm", "image", "vision"] as ModelType[]).map((type) => {
            const model = selectedModels[type];

            return (
              <Tooltip key={type}>
                <TooltipTrigger asChild>
                  <ModelSelectorTrigger asChild>
                    <button
                      className="flex min-w-0 max-w-[136px] items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 aria-expanded:bg-muted/50"
                      onClick={() => setActiveTab(type)}
                      type="button"
                    >
                      <div className="flex size-5.5 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/35 text-muted-foreground">
                        <ModelTypeIcon type={type} />
                      </div>
                      <div className="min-w-0 flex-1 truncate text-[11px] leading-4 font-medium text-foreground">
                        {model.name}
                      </div>
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  </ModelSelectorTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {modelTypeLabels[type]}: {model.name}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>

      <ModelSelectorContent className="max-w-[92vw] sm:max-w-[460px]" title="Select model">
        <SelectorPanel
          activeTab={activeTab}
          selectedModels={selectedModels}
          setActiveTab={setActiveTab}
          setOpen={setOpen}
          setSelectedModels={setSelectedModels}
        />
      </ModelSelectorContent>
    </ModelSelector>
  );
}
