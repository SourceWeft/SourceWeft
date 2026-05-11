import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUp,
  Brain,
  Globe,
  Image as ImageIcon,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@sourceweft/ui-web/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputMentionEditor,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTools,
  type PromptInputMentionSourceLoader,
  type PromptInputMessage,
} from "@sourceweft/ui-web/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import {
  AGENT_TOOL_NAMES,
  isGeneratedImageArtifactToolName,
} from "@sourceweft/sdk";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { SourceItem } from "../source-types";
import { SourceIcon, toAttachmentData } from "./source-rendering";
import {
  buildComposerToolsSelection,
  clampImageConfigToCapabilities,
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  DEFAULT_PROMPT_THINKING_SETTINGS,
  imageAspectRatioOptions,
  imageConfigFromSkills,
  imageConfigSummary,
  imageModelAliasFromSkills,
  imageQualityOptions,
  imageStyleOptions,
  skillSupportsImageGeneration,
  thinkingEffortOptions,
} from "./tool-selection";
import type {
  ChatImageArtifactConfig,
  ChatSkillItem,
  ChatToolName,
  ChatToolsSelection,
  ImageAspectRatio,
  ImageModelCapabilities,
  ImageQuality,
  ImageStyle,
  PromptThinkingCapabilities,
  PromptThinkingSettings,
  ThinkingEffort,
} from "./types";

export function Composer({
  isEditing = false,
  placeholder,
  onSubmit,
  onCancelEditing,
  className,
  initialInput = "",
  inputKey,
  allSources = [],
  sourceMentionLoader,
  selectedSources = [],
  availableSkills = [],
  selectedSkillIds = [],
  onRemoveSource,
  onSkillSelectionChange,
  disabled,
  searchEnabled = false,
  onSearchEnabledChange,
  thinkingCapabilities,
  thinkingSettings = DEFAULT_PROMPT_THINKING_SETTINGS,
  onThinkingSettingsChange,
  imageCapabilities,
  imageModelAvailable = false,
  imageModelAlias,
  disabledToolNames = [],
  onDisabledToolNamesChange,
}: {
  isEditing?: boolean;
  placeholder?: string;
  onSubmit?: (message: PromptInputMessage, tools?: ChatToolsSelection) => void;
  onCancelEditing?: () => void;
  className?: string;
  initialInput?: string;
  inputKey?: string | number;
  allSources?: SourceItem[];
  sourceMentionLoader?: PromptInputMentionSourceLoader;
  selectedSources?: SourceItem[];
  availableSkills?: ChatSkillItem[];
  selectedSkillIds?: string[];
  onRemoveSource?: (id: string) => void;
  onSkillSelectionChange?: (skillIds: string[]) => void;
  disabled?: boolean;
  searchEnabled?: boolean;
  onSearchEnabledChange?: (enabled: boolean) => void;
  thinkingCapabilities?: PromptThinkingCapabilities;
  thinkingSettings?: PromptThinkingSettings;
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
  imageCapabilities?: ImageModelCapabilities;
  imageModelAvailable?: boolean;
  imageModelAlias?: string | null;
  disabledToolNames?: ChatToolName[];
  onDisabledToolNamesChange?: (toolNames: ChatToolName[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [, setDraftText] = useState(initialInput);
  const [imageConfig, setImageConfig] = useState<ChatImageArtifactConfig>(
    DEFAULT_IMAGE_ARTIFACT_CONFIG,
  );
  const [imageConfigPinned, setImageConfigPinned] = useState(false);
  const disabledToolNameSet = useMemo(
    () => new Set(disabledToolNames),
    [disabledToolNames],
  );
  const showSourceCountOnly = selectedSources.length > 2;
  const visible = showSourceCountOnly ? [] : selectedSources;
  const hasSelectedSources = selectedSources.length > 0;
  const imageGenerationEnabled = !disabledToolNameSet.has(
    AGENT_TOOL_NAMES.generateImage,
  );
  const effectiveSelectedSkillIds = useMemo(
    () =>
      imageGenerationEnabled
        ? selectedSkillIds
        : selectedSkillIds.filter((skillId) => {
            const skill = availableSkills.find((item) => item.id === skillId);
            return !skill || !skillSupportsImageGeneration(skill);
          }),
    [availableSkills, imageGenerationEnabled, selectedSkillIds],
  );
  const effectiveSelectedSkillIdSet = useMemo(
    () => new Set(effectiveSelectedSkillIds),
    [effectiveSelectedSkillIds],
  );
  const effectiveSelectedSkills = useMemo(
    () =>
      availableSkills.filter((skill) =>
        effectiveSelectedSkillIdSet.has(skill.id),
      ),
    [availableSkills, effectiveSelectedSkillIdSet],
  );
  const skillImageConfig = useMemo(
    () => imageConfigFromSkills(effectiveSelectedSkills),
    [effectiveSelectedSkills],
  );
  const skillImageModelAlias = useMemo(
    () => imageModelAliasFromSkills(effectiveSelectedSkills),
    [effectiveSelectedSkills],
  );
  const effectiveImageModelAlias = imageModelAlias ?? skillImageModelAlias;
  const selectedSkillNames = effectiveSelectedSkills
    .map((skill) => skill.displayName)
    .join(", ");
  const effectiveImageCapabilities =
    imageCapabilities ?? thinkingCapabilities?.imageGeneration;
  const imageSupported =
    imageModelAvailable && effectiveImageCapabilities?.supported !== false;
  const effectiveImageConfig = clampImageConfigToCapabilities({
    config: imageConfig,
    capabilities: effectiveImageCapabilities,
  });
  const imageOptionsChanged =
    effectiveImageConfig.aspectRatio !== "auto" ||
    effectiveImageConfig.quality !== "auto" ||
    effectiveImageConfig.style !== "auto";
  const imageToolChanged = imageOptionsChanged || !imageGenerationEnabled;
  const imageOptionSummary = imageConfigSummary(effectiveImageConfig);
  const filteredAspectRatioOptions = imageAspectRatioOptions.filter((option) =>
    (
      effectiveImageCapabilities?.controls?.aspectRatio?.values ??
      imageAspectRatioOptions.map((item) => item.value)
    ).includes(option.value),
  );
  const filteredImageQualityOptions = imageQualityOptions.filter((option) =>
    (
      effectiveImageCapabilities?.controls?.quality?.values ??
      imageQualityOptions.map((item) => item.value)
    ).includes(option.value),
  );
  const filteredImageStyleOptions = imageStyleOptions.filter((option) =>
    (
      effectiveImageCapabilities?.controls?.style?.values ??
      imageStyleOptions.map((item) => item.value)
    ).includes(option.value),
  );
  const supportsThinking = thinkingCapabilities?.supportsThinking === true;
  const activeThinkingSettings = supportsThinking
    ? thinkingSettings
    : DEFAULT_PROMPT_THINKING_SETTINGS;
  const optionCount =
    (imageToolChanged ? 1 : 0) +
    (supportsThinking && activeThinkingSettings.mode !== "auto" ? 1 : 0);
  const thinkingEnabled = activeThinkingSettings.mode !== "off";
  const supportedThinkingEfforts = thinkingEffortOptions.filter((option) =>
    (thinkingCapabilities?.supportedEfforts ?? []).includes(option.value),
  );
  const selectedThinkingValue =
    activeThinkingSettings.mode === "off"
      ? "off"
      : activeThinkingSettings.mode === "effort"
        ? activeThinkingSettings.effort
        : "auto";
  const mentionSources = allSources
    .filter(
      (source) => source.sourceType !== "directory" && source.type !== "DIR",
    )
    .map((source) => ({
      id: source.id,
      meta: source.meta,
      title: source.title,
      type: source.type,
    }));

  function updateThinkingSettings(next: PromptThinkingSettings) {
    if (!supportsThinking) {
      return;
    }
    onThinkingSettingsChange?.(next);
  }

  function toggleThinking() {
    if (!activeThinkingSettings) {
      return;
    }

    updateThinkingSettings({
      ...activeThinkingSettings,
      mode: activeThinkingSettings.mode === "off" ? "auto" : "off",
    });
  }

  function updateImageConfig(next: Partial<ChatImageArtifactConfig>) {
    setImageConfig((current) =>
      clampImageConfigToCapabilities({
        config: { ...current, ...next },
        capabilities: effectiveImageCapabilities,
      }),
    );
    setImageConfigPinned(true);
  }

  function updateImageGenerationEnabled(next: boolean) {
    const nextDisabledTools = next
      ? disabledToolNames.filter(
          (toolName) => !isGeneratedImageArtifactToolName(toolName),
        )
      : Array.from(
          new Set([...disabledToolNames, AGENT_TOOL_NAMES.generateImage]),
        );
    onDisabledToolNamesChange?.(nextDisabledTools);
    if (!next) {
      const remainingSkillIds = selectedSkillIds.filter((skillId) => {
        const skill = availableSkills.find((item) => item.id === skillId);
        return !skill || !skillSupportsImageGeneration(skill);
      });
      if (remainingSkillIds.length !== selectedSkillIds.length) {
        onSkillSelectionChange?.(remainingSkillIds);
      }
    }
  }

  useEffect(() => {
    if (imageConfigPinned) {
      return;
    }
    setImageConfig(
      clampImageConfigToCapabilities({
        config: skillImageConfig,
        capabilities: effectiveImageCapabilities,
      }),
    );
  }, [effectiveImageCapabilities, imageConfigPinned, skillImageConfig]);

  useEffect(() => {
    setDraftText(initialInput);
  }, [initialInput, inputKey]);

  useEffect(() => {
    if (!isEditing || disabled) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const input = rootRef.current?.querySelector(
        '[data-chat-prompt-editor="true"], textarea[name="message"]',
      ) as HTMLElement | HTMLTextAreaElement | null;
      if (!input) {
        return;
      }

      input.focus();

      if (input instanceof HTMLTextAreaElement) {
        const end = input.value.length;
        input.setSelectionRange(end, end);
        return;
      }

      const selection = window.getSelection();
      if (!selection) {
        return;
      }

      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [disabled, isEditing, inputKey]);

  return (
    <div className={className} ref={rootRef}>
      <PromptInputProvider initialInput={initialInput} key={inputKey}>
        <PromptInput
          onSubmit={(message) => {
            if (disabled) {
              return;
            }
            const tools = buildComposerToolsSelection({
              imageGenerationEnabled,
              imageSupported,
              selectedSkills: effectiveSelectedSkills,
              imageConfig: effectiveImageConfig,
              imageModelAlias: effectiveImageModelAlias,
            });
            (onSubmit ?? (() => undefined))(message, tools);
          }}
        >
          {hasSelectedSources ? (
            <PromptInputHeader>
              <Attachments className="gap-2.5 pt-0.5" variant="inline">
                {showSourceCountOnly ? (
                  <Attachment
                    className="rounded-2xl bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground"
                    data={{
                      id: "source-count",
                      mediaType: "text/plain",
                      sourceId: "source-count",
                      title: `${selectedSources.length} selected sources`,
                      type: "source-document",
                    }}
                  >
                    {selectedSources.length} selected sources
                  </Attachment>
                ) : (
                  visible.map((source) => (
                    <Attachment
                      className="rounded-2xl bg-muted/55 px-3.5 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]"
                      data={toAttachmentData(source)}
                      key={source.id}
                      onRemove={() => onRemoveSource?.(source.id)}
                    >
                      <AttachmentPreview
                        className="text-foreground/75"
                        fallbackIcon={
                          <SourceIcon className="size-4" source={source} />
                        }
                      />
                      <AttachmentInfo className="max-w-[220px] text-[13px] font-medium" />
                      <AttachmentRemove
                        className="text-foreground/55 hover:bg-background/60"
                        label={`Remove ${source.title}`}
                      />
                    </Attachment>
                  ))
                )}
              </Attachments>
            </PromptInputHeader>
          ) : null}
          <PromptInputBody>
            <PromptInputMentionEditor
              autoFocus={isEditing && !disabled}
              data-chat-prompt-editor="true"
              disabled={disabled}
              initialValue={initialInput}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (isEditing && event.key === "Escape") {
                  event.preventDefault();
                  onCancelEditing?.();
                  return;
                }

                if (
                  disabled &&
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                }
              }}
              placeholder={
                placeholder ||
                "Message your documents, links, or connected tools..."
              }
              onValueChange={({ text }) => setDraftText(text)}
              sourceLoader={sourceMentionLoader}
              sources={mentionSources}
            />
          </PromptInputBody>
          <PromptInputFooter className="border-t-0">
            <PromptInputTools className="w-full flex-wrap gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <PromptInputButton
                      className={cn(
                        "relative size-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
                        optionCount > 0 &&
                          "bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background",
                      )}
                      size="icon-sm"
                      tooltip="Options"
                      type="button"
                      variant={optionCount > 0 ? "secondary" : "ghost"}
                    >
                      <SlidersHorizontal className="size-3.5" />
                      {optionCount > 0 ? (
                        <span className="-top-0.5 -right-0.5 absolute flex size-3 items-center justify-center rounded-full bg-primary text-[8px] text-primary-foreground">
                          {optionCount}
                        </span>
                      ) : null}
                      <span className="sr-only">Options</span>
                    </PromptInputButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64 p-1">
                    <DropdownMenuLabel className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      Options
                    </DropdownMenuLabel>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="h-9 min-w-0 overflow-hidden rounded-lg px-2 text-xs whitespace-nowrap">
                        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="shrink-0">Image generation</span>
                          <span
                            className={cn(
                              "ml-auto min-w-0 max-w-[108px] truncate text-right text-muted-foreground",
                              imageToolChanged && "text-primary",
                            )}
                          >
                            {imageGenerationEnabled
                              ? imageOptionSummary
                              : "Off"}
                          </span>
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        alignOffset={-6}
                        className="max-h-[min(520px,var(--radix-dropdown-menu-content-available-height))] w-[340px] overflow-y-auto p-3"
                        sideOffset={8}
                      >
                        <div className="space-y-3.5">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-foreground">
                                Image generation
                              </div>
                            </div>
                            <Switch
                              checked={imageGenerationEnabled}
                              onCheckedChange={(checked) =>
                                updateImageGenerationEnabled(Boolean(checked))
                              }
                              size="sm"
                            />
                          </div>
                          {!imageSupported ? (
                            <div className="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                              Select an image model to generate.
                            </div>
                          ) : null}
                          <ImageConfigGroup
                            disabled={
                              !imageSupported || !imageGenerationEnabled
                            }
                            label="Aspect ratio"
                            onValueChange={(value) =>
                              updateImageConfig({
                                aspectRatio: value as ImageAspectRatio,
                              })
                            }
                            options={filteredAspectRatioOptions}
                            value={effectiveImageConfig.aspectRatio}
                          />
                          <ImageConfigGroup
                            disabled={
                              !imageSupported || !imageGenerationEnabled
                            }
                            label="Image quality"
                            onValueChange={(value) =>
                              updateImageConfig({
                                quality: value as ImageQuality,
                              })
                            }
                            options={filteredImageQualityOptions}
                            value={effectiveImageConfig.quality}
                          />
                          <ImageConfigGroup
                            disabled={
                              !imageSupported || !imageGenerationEnabled
                            }
                            label="Style"
                            onValueChange={(value) =>
                              updateImageConfig({
                                style: value as ImageStyle,
                              })
                            }
                            options={filteredImageStyleOptions}
                            value={effectiveImageConfig.style}
                          />
                          <div className="flex items-center justify-between border-border/60 border-t pt-2">
                            <span className="text-[11px] text-muted-foreground">
                              {imageGenerationEnabled
                                ? imageOptionSummary
                                : "Off"}
                            </span>
                            <button
                              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              onClick={() => {
                                setImageConfig(DEFAULT_IMAGE_ARTIFACT_CONFIG);
                                setImageConfigPinned(false);
                                updateImageGenerationEnabled(true);
                              }}
                              type="button"
                            >
                              <RotateCcw className="size-3" />
                              Reset
                            </button>
                          </div>
                        </div>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                    {supportsThinking && supportedThinkingEfforts.length > 0 ? (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="h-9 min-w-0 overflow-hidden rounded-lg px-2 text-xs whitespace-nowrap">
                          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                            <Brain className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="shrink-0">Thinking</span>
                            <span className="ml-auto min-w-0 max-w-[108px] truncate text-right text-muted-foreground">
                              {selectedThinkingValue === "off"
                                ? "Off"
                                : selectedThinkingValue === "auto"
                                  ? "Auto"
                                  : thinkingEffortOptions.find(
                                      (option) =>
                                        option.value === selectedThinkingValue,
                                    )?.label}
                            </span>
                          </span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-36 p-1">
                          <DropdownMenuRadioGroup
                            onValueChange={(value) => {
                              if (value === "off") {
                                updateThinkingSettings({
                                  ...(activeThinkingSettings ??
                                    DEFAULT_PROMPT_THINKING_SETTINGS),
                                  mode: "off",
                                });
                                return;
                              }

                              if (value === "auto") {
                                updateThinkingSettings({
                                  ...(activeThinkingSettings ??
                                    DEFAULT_PROMPT_THINKING_SETTINGS),
                                  mode: "auto",
                                });
                                return;
                              }

                              updateThinkingSettings({
                                mode: "effort",
                                effort: value as ThinkingEffort,
                              });
                            }}
                            value={selectedThinkingValue}
                          >
                            <DropdownMenuRadioItem
                              className="h-7 rounded-lg py-1.5 pr-7 pl-2 text-xs"
                              value="off"
                            >
                              Off
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem
                              className="h-7 rounded-lg py-1.5 pr-7 pl-2 text-xs"
                              value="auto"
                            >
                              Auto
                            </DropdownMenuRadioItem>
                            {supportedThinkingEfforts.map((option) => (
                              <DropdownMenuRadioItem
                                className="h-7 rounded-lg py-1.5 pr-7 pl-2 text-xs"
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : (
                      <DropdownMenuItem
                        className="h-9 rounded-lg px-2 text-xs"
                        disabled
                      >
                        {supportsThinking
                          ? "Thinking effort unavailable"
                          : "No reasoning options available"}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>

                {effectiveSelectedSkillIds.length > 0 ? (
                  <PromptInputButton
                    aria-pressed
                    className="rounded-xl bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background"
                    size="icon-sm"
                    tooltip={selectedSkillNames || "Selected skills"}
                    type="button"
                    variant="secondary"
                  >
                    <Sparkles className="size-4" />
                    <span className="sr-only">Selected skills</span>
                  </PromptInputButton>
                ) : null}

                <PromptInputButton
                  aria-pressed={searchEnabled}
                  className={
                    searchEnabled
                      ? "rounded-xl bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background"
                      : "rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                  }
                  onClick={() => onSearchEnabledChange?.(!searchEnabled)}
                  size="icon-sm"
                  tooltip={{ content: "Search sources", shortcut: "S" }}
                  type="button"
                  variant={searchEnabled ? "secondary" : "ghost"}
                >
                  <Globe className="size-4" />
                  <span className="sr-only">Search</span>
                </PromptInputButton>

                {supportsThinking ? (
                  <button
                    aria-label={
                      thinkingEnabled ? "Disable Thinking" : "Enable Thinking"
                    }
                    aria-pressed={thinkingEnabled}
                    className={cn(
                      "ml-1 inline-flex h-8 items-center justify-center overflow-hidden rounded-full text-xs font-medium select-none transition-all duration-200 ease-out",
                      thinkingEnabled
                        ? "gap-1.5 bg-foreground px-2.5 text-background shadow-sm hover:bg-foreground/90"
                        : "w-8 border border-transparent bg-transparent px-0 text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={toggleThinking}
                    title={
                      thinkingEnabled ? "Disable Thinking" : "Enable Thinking"
                    }
                    type="button"
                  >
                    <Brain
                      className={cn(
                        "size-4 shrink-0 transition-transform duration-300 ease-out",
                        thinkingEnabled
                          ? "rotate-180 scale-110"
                          : "rotate-0 scale-100",
                      )}
                    />
                    <span
                      className={cn(
                        "overflow-hidden whitespace-nowrap transition-all duration-200 ease-out",
                        thinkingEnabled
                          ? "max-w-20 opacity-100"
                          : "max-w-0 opacity-0",
                      )}
                    >
                      Thinking
                    </span>
                  </button>
                ) : null}
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                {isEditing && onCancelEditing ? (
                  <PromptInputButton
                    className="size-7 rounded-full bg-muted/60 text-red-500/90 ring-1 ring-border/55 transition-colors hover:bg-muted/80 hover:text-red-500"
                    onClick={onCancelEditing}
                    size="icon-sm"
                    tooltip="Cancel edit (Esc)"
                    type="button"
                    variant="ghost"
                  >
                    <X className="size-3.5" />
                    <span className="sr-only">Cancel edit</span>
                  </PromptInputButton>
                ) : null}

                <div
                  className={cn(
                    "transition-opacity",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <PromptInputSubmit
                    aria-disabled={disabled || undefined}
                    className="size-9 shrink-0 rounded-full px-0 shadow-xs"
                    onClick={
                      disabled
                        ? (event) => {
                            event.preventDefault();
                          }
                        : undefined
                    }
                    status={disabled ? "streaming" : undefined}
                    tabIndex={disabled ? -1 : undefined}
                    type={disabled ? "button" : "submit"}
                  >
                    <ArrowUp className="size-4" />
                    <span className="sr-only">Send</span>
                  </PromptInputSubmit>
                </div>
              </div>
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
}

function ImageConfigGroup({
  disabled,
  label,
  onValueChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground/85">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "h-7 rounded-md border px-2 text-xs transition-colors",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border/70 bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                disabled &&
                  "cursor-not-allowed opacity-45 hover:bg-background hover:text-muted-foreground",
              )}
              disabled={disabled}
              key={option.value}
              onClick={() => onValueChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
