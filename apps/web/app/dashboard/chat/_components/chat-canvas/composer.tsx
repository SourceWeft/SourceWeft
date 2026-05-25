import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { FileUIPart } from "ai";
import {
  ArrowUp,
  Brain,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import {
  Attachment,
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  getAttachmentLabel,
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
  usePromptInputAttachments,
  type PromptInputMentionSourceLoader,
  type PromptInputMessage,
  type PromptInputSegment,
  type PromptInputSlashCommand,
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
  getAgentToolSlashCommand,
  isGeneratedImageArtifactToolName,
  isNotionToolName,
} from "@sourceweft/sdk";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { SkillIcon } from "../../../_components/dashboard-icons";
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
  notionAgentToolNames,
  skillSupportsImageGeneration,
  skillSupportsNotion,
  thinkingEffortOptions,
} from "./tool-selection";
import type {
  ChatSendInput,
  ChatConnectorToolSelection,
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

type ComposerSlashCommandMeta =
  | {
      command: NonNullable<ChatSkillItem["commands"]>[number];
      kind: "skill-command";
      skill: ChatSkillItem;
    }
  | {
      kind: "tool-command";
      tool: ChatToolName;
    }
  | {
      kind: "skill";
      skill: ChatSkillItem;
    };

function commandDisplayNameFallback(command: ChatSendInput["command"]) {
  if (!command?.name) {
    return "";
  }
  const legacyDisplayName = sanitizeCommandDisplayName(command.displayName);
  if (legacyDisplayName) {
    return legacyDisplayName;
  }
  const normalized = command.name.startsWith("/")
    ? command.name
    : `/${command.name}`;
  if (command.kind === "tool" || command.toolName) {
    return normalized === "/generate_image" ? "Generate image" : normalized;
  }
  const name = command.commandName ?? normalized.replace(/^\//, "").split(":")[0] ?? normalized;
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function humanizeCommandName(value: string) {
  return value
    .replace(/^\//, "")
    .split(":")
    .pop()!
    .split(/[.\-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sanitizeCommandDisplayName(displayName: string | undefined) {
  const trimmed = displayName?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? humanizeCommandName(trimmed) : trimmed;
}

function commandKindForPromptInput(
  command: ChatSendInput["command"],
): PromptInputSlashCommand["kind"] {
  return command?.kind === "tool" || command?.toolName ? "tool" : "skill";
}

function createPromptCommandMarker(input: {
  kind: "skill" | "skill-command" | "tool";
  label?: string;
  value: string;
}) {
  const normalizedValue = input.value.startsWith("/")
    ? input.value
    : `/${input.value}`;
  const prefix =
    input.kind === "tool"
      ? "tool"
      : input.kind === "skill-command"
        ? "skill-command"
        : "skills";
  const markerValue = encodeURIComponent(normalizedValue.replace(/^\//, ""));
  const label = escapeMarkerLabel(input.label?.trim() || normalizedValue);
  return `[${prefix}:${markerValue}](${label})`;
}

function escapeMarkerLabel(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]").replaceAll(")", "\\)");
}

function createPromptSourceMarker(input: { sourceId: string; title: string }) {
  return `[source:${encodeURIComponent(input.sourceId)}](${escapeMarkerLabel(input.title)})`;
}

function promptSegmentsToMarkerContent(segments: PromptInputSegment[]) {
  return segments
    .map((segment) => {
      if (segment.type === "command") {
        return segment.command.marker;
      }
      if (segment.type === "source") {
        return createPromptSourceMarker({
          sourceId: segment.sourceId,
          title: segment.title,
        });
      }
      return segment.text;
    })
    .join("")
    .trim();
}

function promptSegmentsToUserText(segments: PromptInputSegment[]) {
  return segments
    .map((segment) => {
      if (segment.type === "source") {
        return `@${segment.title}`;
      }
      if (segment.type === "command") {
        return "";
      }
      return segment.text;
    })
    .join("")
    .trim();
}

function uniqueCommandSegments(segments: PromptInputSegment[]) {
  const seen = new Set<string>();
  return segments.filter(
    (segment): segment is Extract<PromptInputSegment, { type: "command" }> => {
      if (segment.type !== "command") {
        return false;
      }
      const key = `${segment.command.kind ?? ""}:${segment.command.value.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    },
  );
}

type ResolvedComposerCommand =
  | {
      arguments: string;
      command: NonNullable<ChatSkillItem["commands"]>[number];
      kind: "skill-command";
      skill: ChatSkillItem;
    }
  | {
      arguments: string;
      kind: "skill";
      skill: ChatSkillItem;
    }
  | {
      arguments: string;
      kind: "tool-command";
      toolName: ChatToolName;
      name: `/${string}`;
    };

function notionOptionSummary(enabled: boolean, connectorId: string | null) {
  if (!connectorId) {
    return "Unavailable";
  }
  return enabled ? "On" : "Off";
}

export function Composer({
  isEditing = false,
  placeholder,
  onSubmit,
  onCancelEditing,
  className,
  initialAttachments = [],
  initialInput = "",
  initialCommand = null,
  inputKey,
  allSources = [],
  sourceMentionLoader,
  selectedSources = [],
  availableSkills = [],
  selectedSkillIds = [],
  selectedMcpInstallIds = [],
  selectedMcpToolIds = [],
  onRemoveSource,
  onSkillSelectionChange,
  submitDisabled = false,
  searchEnabled = false,
  onSearchEnabledChange,
  thinkingCapabilities,
  thinkingSettings = DEFAULT_PROMPT_THINKING_SETTINGS,
  onThinkingSettingsChange,
  imageCapabilities,
  imageModelAvailable = false,
  imageModelAlias,
  notionConnectorId = null,
  disabledToolNames = [],
  onDisabledToolNamesChange,
  onStopStreaming,
  isStopping = false,
}: {
  isEditing?: boolean;
  placeholder?: string;
  onSubmit?: (
    message: PromptInputMessage,
    tools?: ChatToolsSelection,
    command?: ChatSendInput["command"],
    skillIds?: string[],
    content?: string,
  ) => void;
  onCancelEditing?: () => void;
  className?: string;
  initialAttachments?: (FileUIPart & { id: string })[];
  initialInput?: string;
  initialCommand?: ChatSendInput["command"] | null;
  inputKey?: string | number;
  allSources?: SourceItem[];
  sourceMentionLoader?: PromptInputMentionSourceLoader;
  selectedSources?: SourceItem[];
  availableSkills?: ChatSkillItem[];
  selectedSkillIds?: string[];
  selectedMcpInstallIds?: string[];
  selectedMcpToolIds?: string[];
  onRemoveSource?: (id: string) => void;
  onSkillSelectionChange?: (skillIds: string[]) => void;
  submitDisabled?: boolean;
  searchEnabled?: boolean;
  onSearchEnabledChange?: (enabled: boolean) => void;
  thinkingCapabilities?: PromptThinkingCapabilities;
  thinkingSettings?: PromptThinkingSettings;
  onThinkingSettingsChange?: (settings: PromptThinkingSettings) => void;
  imageCapabilities?: ImageModelCapabilities;
  imageModelAvailable?: boolean;
  imageModelAlias?: string | null;
  notionConnectorId?: string | null;
  disabledToolNames?: ChatToolName[];
  onDisabledToolNamesChange?: (toolNames: ChatToolName[]) => void;
  onStopStreaming?: () => void;
  isStopping?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [, setDraftText] = useState(initialInput);
  const [draftSegments, setDraftSegments] = useState<PromptInputSegment[]>([]);
  const [composerSessionKey, setComposerSessionKey] = useState(0);
  const previousEditingRef = useRef(isEditing);
  const [imageConfig, setImageConfig] = useState<ChatImageArtifactConfig>(
    DEFAULT_IMAGE_ARTIFACT_CONFIG,
  );
  const [imageConfigPinned, setImageConfigPinned] = useState(false);
  const disabledToolNameSet = useMemo(
    () => new Set(disabledToolNames),
    [disabledToolNames],
  );
  const imageGenerationEnabled = !disabledToolNameSet.has(
    AGENT_TOOL_NAMES.generateImage,
  );
  const notionToolsAvailable = Boolean(notionConnectorId);
  const notionToolsEnabled =
    notionToolsAvailable &&
    !notionAgentToolNames.some((toolName) => disabledToolNameSet.has(toolName));
  const effectiveSelectedSkillIds = useMemo(
    () =>
      selectedSkillIds.filter((skillId) => {
        const skill = availableSkills.find((item) => item.id === skillId);
        if (!skill) {
          return true;
        }
        if (!imageGenerationEnabled && skillSupportsImageGeneration(skill)) {
          return false;
        }
        if (!notionToolsEnabled && skillSupportsNotion(skill)) {
          return false;
        }
        return true;
      }),
    [
      availableSkills,
      imageGenerationEnabled,
      notionToolsEnabled,
      selectedSkillIds,
    ],
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
  const notionToolChanged = notionToolsAvailable && !notionToolsEnabled;
  const mcpToolChanged =
    selectedMcpInstallIds.length > 0 || selectedMcpToolIds.length > 0;
  const notionSummary = notionOptionSummary(
    notionToolsEnabled,
    notionConnectorId,
  );
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
    (notionToolChanged ? 1 : 0) +
    (mcpToolChanged ? 1 : 0) +
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
  const initialAttachmentsKey = initialAttachments
    .map(
      (attachment) =>
        `${attachment.id}:${attachment.url}:${attachment.filename ?? ""}`,
    )
    .join("|");
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
  const slashCommandOptions = useMemo<PromptInputSlashCommand[]>(
    () => {
      const generateImageSlash = getAgentToolSlashCommand(
        AGENT_TOOL_NAMES.generateImage,
      );
      const notionToolCommands: PromptInputSlashCommand[] = notionToolsAvailable
        ? notionAgentToolNames.flatMap((toolName) => {
            const slash = getAgentToolSlashCommand(toolName);
            return slash
              ? [
                  {
                    description: slash.description,
                    group: "Notion",
                    id: `tool-command:${toolName}`,
                    kind: "tool" as const,
                    label: slash.displayName,
                    meta: {
                      kind: "tool-command",
                      tool: toolName,
                    } satisfies ComposerSlashCommandMeta,
                    value: `/${toolName}`,
                  },
                ]
              : [];
          })
        : [];
      const notionCommands: PromptInputSlashCommand[] =
        notionToolCommands.length > 0
          ? [
              {
                children: notionToolCommands,
                description: "Search, create, update, and save Notion pages",
                group: "Tools",
                id: "tool-group:notion",
                kind: "tool" as const,
                label: "Notion",
                value: "/notion",
              },
            ]
          : [];
      const toolCommands: PromptInputSlashCommand[] =
        imageSupported && generateImageSlash
          ? [
              {
                description: generateImageSlash.description,
                group: "Tools",
                id: "tool-command:generate_image",
                kind: "tool",
                label: generateImageSlash.displayName,
                meta: {
                  kind: "tool-command",
                  tool: AGENT_TOOL_NAMES.generateImage,
                } satisfies ComposerSlashCommandMeta,
                value: "/generate_image",
              },
            ]
          : [];
      const skillCommands = availableSkills.flatMap((skill) =>
        skill.slash === false || skill.slashConfig?.enabled === false
          ? []
          : (skill.commands ?? [])
              .filter((command) => command.slash !== false)
              .map((command) => ({
                description: [skill.displayName, command.description]
                  .filter(Boolean)
                  .join(" · "),
                group: skill.displayName,
                id: `${skill.id}:${command.id}`,
                kind: "skill-command" as const,
                label:
                  sanitizeCommandDisplayName(command.displayName) ||
                  command.title ||
                  humanizeCommandName(command.name),
                meta: {
                  command,
                  kind: "skill-command",
                  skill,
                } satisfies ComposerSlashCommandMeta,
                value: command.canonicalName,
              })),
      );
      const skillActivationCommands = availableSkills
        .filter(
          (skill) =>
            skill.slash !== false && skill.slashConfig?.enabled !== false,
        )
        .map((skill) => ({
          description: skill.description,
          group: "Skills",
          id: `skill:${skill.id}`,
          kind: "skill" as const,
          label: skill.displayName,
          meta: {
            kind: "skill",
            skill,
          } satisfies ComposerSlashCommandMeta,
          value: `/${skill.slug}`,
        }));
      return [
        ...toolCommands,
        ...notionCommands,
        ...skillCommands,
        ...skillActivationCommands,
      ];
    },
    [availableSkills, imageSupported, notionToolsAvailable],
  );
  const commandByCanonicalName = useMemo(() => {
    const map = new Map<
      string,
      {
        command: NonNullable<ChatSkillItem["commands"]>[number];
        skill: ChatSkillItem;
      }
    >();
    for (const skill of availableSkills) {
      for (const command of skill.commands ?? []) {
        map.set(command.canonicalName.toLowerCase(), { command, skill });
      }
    }
    return map;
  }, [availableSkills]);

  function supportsSkillSlash(
    skill: ChatSkillItem | undefined,
  ): skill is ChatSkillItem {
    return Boolean(
      skill &&
        skill.slash !== false &&
        skill.slashConfig?.enabled !== false,
    );
  }

  const initialPromptSegments = useMemo<PromptInputSegment[]>(() => {
    const commandName = initialCommand?.name?.trim();
    const textSegments: PromptInputSegment[] = [];
    if (!commandName) {
      return textSegments;
    }
    const canonicalName = commandName.startsWith("/")
      ? commandName
      : `/${commandName}`;
    const command = initialCommand;
    if (!command) {
      return textSegments;
    }
    return [
      {
        command: {
          kind: commandKindForPromptInput(command) ?? "skill",
          label: commandDisplayNameFallback(command),
          marker: createPromptCommandMarker({
            kind: commandKindForPromptInput(command) ?? "skill",
            label: commandDisplayNameFallback(command),
            value: canonicalName,
          }),
          value: canonicalName,
        },
        type: "command",
      },
      ...(initialInput ? [{ text: ` ${initialInput}`, type: "text" } as const] : []),
    ];
  }, [initialCommand, initialInput]);
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

  function updateNotionToolsEnabled(next: boolean) {
    const nextDisabledTools = next
      ? disabledToolNames.filter((toolName) => !isNotionToolName(toolName))
      : Array.from(new Set([...disabledToolNames, ...notionAgentToolNames]));
    onDisabledToolNamesChange?.(nextDisabledTools);
    if (!next) {
      const remainingSkillIds = selectedSkillIds.filter((skillId) => {
        const skill = availableSkills.find((item) => item.id === skillId);
        return !skill || !skillSupportsNotion(skill);
      });
      if (remainingSkillIds.length !== selectedSkillIds.length) {
        onSkillSelectionChange?.(remainingSkillIds);
      }
    }
  }

  function applyCommandTools(command: NonNullable<ChatSkillItem["commands"]>[number]) {
    if (command.tools?.includes(AGENT_TOOL_NAMES.webSearch)) {
      onSearchEnabledChange?.(true);
    }
    if (command.tools?.includes(AGENT_TOOL_NAMES.generateImage)) {
      updateImageGenerationEnabled(true);
    }
    if (command.tools?.some((toolName) => isNotionToolName(toolName))) {
      updateNotionToolsEnabled(true);
    }
  }

  function buildCommandSkillIds(skill: ChatSkillItem | undefined) {
    return skill ? [skill.id] : [];
  }

  function resolveTokenCommand(
    commandName: string,
    argumentsText = "",
  ): ResolvedComposerCommand | null {
    const args = argumentsText.trim();
    const normalizedToolName = commandName.replace(/^\//, "").toLowerCase();
    if (normalizedToolName === AGENT_TOOL_NAMES.generateImage) {
      return {
        arguments: args,
        kind: "tool-command",
        name: "/generate_image",
        toolName: AGENT_TOOL_NAMES.generateImage,
      };
    }
    const notionToolName = notionAgentToolNames.find(
      (toolName) => toolName.toLowerCase() === normalizedToolName,
    );
    if (notionToolsAvailable && notionToolName) {
      return {
        arguments: args,
        kind: "tool-command",
        name: `/${notionToolName}`,
        toolName: notionToolName,
      };
    }

    const skillActivation = availableSkills.find(
      (skill) =>
        commandName.toLowerCase() === `/${skill.slug}`.toLowerCase() &&
        supportsSkillSlash(skill),
    );
    if (skillActivation) {
      return {
        arguments: args,
        kind: "skill",
        skill: skillActivation,
      };
    }

    const resolvedCommand = commandByCanonicalName.get(commandName.toLowerCase());
    if (
      resolvedCommand &&
      supportsSkillSlash(resolvedCommand.skill) &&
      resolvedCommand.command.slash !== false
    ) {
      return {
        arguments: args,
        command: resolvedCommand.command,
        kind: "skill-command",
        skill: resolvedCommand.skill,
      };
    }

    return null;
  }

  function resolveTokenCommands(
    commands: Array<Extract<PromptInputSegment, { type: "command" }>["command"]>,
  ) {
    const resolved: ResolvedComposerCommand[] = [];
    const seenSkillIds = new Set<string>();
    const seenTools = new Set<string>();

    for (const command of commands) {
      const commandName = command.value.startsWith("/")
        ? command.value
        : `/${command.value}`;
      const tokenCommand = resolveTokenCommand(commandName);
      if (!tokenCommand) {
        continue;
      }

      if (tokenCommand.kind === "skill" && seenSkillIds.has(tokenCommand.skill.id)) {
        continue;
      }
      if (
        tokenCommand.kind === "tool-command" &&
        seenTools.has(tokenCommand.name)
      ) {
        continue;
      }

      if (tokenCommand.kind === "skill") {
        seenSkillIds.add(tokenCommand.skill.id);
      } else if (tokenCommand.kind === "tool-command") {
        seenTools.add(tokenCommand.name);
      }
      resolved.push(tokenCommand);
    }

    return resolved;
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
    setDraftSegments(initialPromptSegments);
  }, [initialCommand, initialInput, initialPromptSegments, inputKey]);

  useEffect(() => {
    if (previousEditingRef.current !== isEditing) {
      previousEditingRef.current = isEditing;
      setComposerSessionKey((value) => value + 1);
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) {
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
  }, [isEditing, inputKey]);

  return (
    <div className={className} ref={rootRef}>
      <PromptInputProvider
        initialAttachments={initialAttachments}
        initialInput={initialInput}
        key={`${String(inputKey ?? "composer")}:${composerSessionKey}:${initialAttachmentsKey}`}
      >
        <PromptInput
          accept="image/png,image/jpeg,image/webp,image/gif"
          maxFileSize={10 * 1024 * 1024}
          maxFiles={8}
          multiple
          submitDisabled={submitDisabled}
          onSubmit={(message) => {
            if (submitDisabled) {
              return;
            }
            const submittedSegments = message.segments ?? draftSegments;
            const submittedCommandSegments =
              uniqueCommandSegments(submittedSegments);
            const markerContent = promptSegmentsToMarkerContent(submittedSegments);
            const userTextContent = promptSegmentsToUserText(submittedSegments);
            const tokenResolvedCommands = resolveTokenCommands(
              submittedCommandSegments.map((segment) => segment.command),
            );
            const activeCommand =
              [...tokenResolvedCommands]
                .reverse()
                .find((command) => command.kind === "skill-command") ?? null;
            const activeToolCommand =
              activeCommand === null
                ? ([...tokenResolvedCommands]
                    .reverse()
                    .find((command) => command.kind === "tool-command") ?? null)
                : null;
            const invokedSkillIds = [
              ...new Set(
                tokenResolvedCommands
                  .flatMap((command) =>
                    command.kind === "skill" ||
                    command.kind === "skill-command"
                      ? buildCommandSkillIds(command.skill)
                      : [],
                  )
                  .filter(Boolean),
              ),
            ].slice(0, 5);
            const turnSkillIds = [
              ...new Set([...effectiveSelectedSkillIds, ...invokedSkillIds]),
            ].slice(0, 5);
            const submittedMessage = message;
            const commandRequest =
              activeCommand?.kind === "skill-command"
                ? {
                    arguments: markerContent,
                    kind: "skill-command" as const,
                    name: activeCommand.command.canonicalName,
                  }
                : activeToolCommand?.kind === "tool-command"
                  ? {
                      arguments: userTextContent,
                      kind: "tool" as const,
                      name: activeToolCommand.name,
                      toolName: activeToolCommand.toolName,
                    }
                  : undefined;
            const tools = buildComposerToolsSelection({
              imageGenerationEnabled,
              imageSupported,
              notionConnectorId,
              notionToolsEnabled,
              selectedSkills: availableSkills.filter((skill) =>
                turnSkillIds.includes(skill.id),
              ),
              imageConfig: effectiveImageConfig,
              imageModelAlias: effectiveImageModelAlias,
            });
            const toolCommandNames = new Set(
              tokenResolvedCommands
                .filter((command) => command.kind === "tool-command")
                .map((command) => command.toolName),
            );
            const toolsWithTokenCommands = toolCommandNames.size
              ? {
                  ...(tools ?? {}),
                  ...Object.fromEntries(
                    Array.from(toolCommandNames).flatMap((toolName) => {
                      if (!isNotionToolName(toolName)) {
                        return [];
                      }
                      const connectorTools = tools as
                        | Record<string, ChatConnectorToolSelection | undefined>
                        | undefined;
                      return [
                        [
                          toolName,
                          {
                            ...(connectorTools?.[toolName] ?? {}),
                            ...(notionConnectorId
                              ? { connectorId: notionConnectorId }
                              : {}),
                            enabled: true,
                          },
                        ] as const,
                      ];
                    }),
                  ),
                }
              : tools;
            const toolsWithInvokedSkills =
              invokedSkillIds.length > 0
                ? {
                    ...(toolsWithTokenCommands ?? {}),
                    invokedSkillIds,
                  }
                : toolsWithTokenCommands;
            const toolsWithMcp =
              selectedMcpInstallIds.length > 0 || selectedMcpToolIds.length > 0
                ? {
                    ...(toolsWithInvokedSkills ?? {}),
                    mcp: {
                      enabled: true,
                      installIds: selectedMcpInstallIds,
                      toolIds: selectedMcpToolIds,
                    },
                  }
                : toolsWithInvokedSkills;
            (onSubmit ?? (() => undefined))(
              submittedMessage,
              toolsWithMcp,
              commandRequest,
              turnSkillIds,
              markerContent,
            );
            setComposerSessionKey((value) => value + 1);
          }}
        >
          <ComposerAttachmentsHeader
            onRemoveSource={onRemoveSource}
            selectedSources={selectedSources}
          />
          <PromptInputBody>
            <PromptInputMentionEditor
              autoFocus={isEditing}
              data-chat-prompt-editor="true"
              initialSegments={initialPromptSegments}
              initialValue={initialInput}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (isEditing && event.key === "Escape") {
                  event.preventDefault();
                  onCancelEditing?.();
                  return;
                }

                if (
                  submitDisabled &&
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
              onValueChange={({ segments, text }) => {
                setDraftText(text);
                setDraftSegments(segments);
              }}
              onSlashCommandSelect={(option: PromptInputSlashCommand) => {
                const meta = option.meta as ComposerSlashCommandMeta | undefined;
                if (!meta) {
                  return;
                }
                if (meta.kind === "tool-command") {
                  return;
                }
                if (meta.kind === "skill") {
                  return;
                }
                applyCommandTools(meta.command);
              }}
              slashCommands={slashCommandOptions}
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
                    {notionToolsAvailable ? (
                      <>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="h-9 min-w-0 overflow-hidden rounded-lg px-2 text-xs whitespace-nowrap">
                            <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="shrink-0">Notion</span>
                              <span
                                className={cn(
                                  "ml-auto min-w-0 max-w-[108px] truncate text-right text-muted-foreground",
                                  notionToolChanged && "text-primary",
                                )}
                              >
                                {notionSummary}
                              </span>
                            </span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-64 p-3">
                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-xs font-medium text-foreground">
                                    Notion tools
                                  </div>
                                </div>
                                <Switch
                                  checked={notionToolsEnabled}
                                  onCheckedChange={(checked) =>
                                    updateNotionToolsEnabled(Boolean(checked))
                                  }
                                  size="sm"
                                />
                              </div>
                              <div className="flex items-center justify-between border-border/60 border-t pt-2">
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {notionSummary}
                                </span>
                                <button
                                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                  onClick={() => updateNotionToolsEnabled(true)}
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
                      </>
                    ) : null}
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
                    <SkillIcon className="size-4" />
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

                <ComposerAddImageButton />

                <div>
                  {submitDisabled && onStopStreaming ? (
                    <PromptInputButton
                      className="size-9 shrink-0 rounded-full px-0 shadow-xs"
                      disabled={isStopping}
                      onClick={onStopStreaming}
                      size="icon-sm"
                      tooltip={isStopping ? "Stopping" : "Stop"}
                      type="button"
                      variant="default"
                    >
                      {isStopping ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Square className="size-3.5 fill-current" />
                      )}
                      <span className="sr-only">
                        {isStopping ? "Stopping" : "Stop"}
                      </span>
                    </PromptInputButton>
                  ) : (
                    <PromptInputSubmit
                      aria-disabled={submitDisabled || undefined}
                      className="size-9 shrink-0 rounded-full px-0 shadow-xs"
                      onClick={
                        submitDisabled
                          ? (event) => {
                              event.preventDefault();
                            }
                          : undefined
                      }
                      status={submitDisabled ? "streaming" : undefined}
                      tabIndex={submitDisabled ? -1 : undefined}
                      type={submitDisabled ? "button" : "submit"}
                    >
                      <ArrowUp className="size-4" />
                      <span className="sr-only">Send</span>
                    </PromptInputSubmit>
                  )}
                </div>
              </div>
            </PromptInputTools>
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
}

function ComposerAttachmentsHeader({
  onRemoveSource,
  selectedSources,
}: {
  onRemoveSource?: (id: string) => void;
  selectedSources: SourceItem[];
}) {
  const attachments = usePromptInputAttachments();
  const images = attachments.files.filter((file) =>
    file.mediaType?.startsWith("image/"),
  );
  const showSourceCountOnly = selectedSources.length > 2;
  const visibleSources = showSourceCountOnly ? [] : selectedSources;

  if (selectedSources.length === 0 && images.length === 0) {
    return null;
  }

  return (
    <PromptInputHeader className="items-start">
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
          visibleSources.map((source) => (
            <Attachment
              className="rounded-2xl bg-muted/55 px-3.5 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]"
              data={toAttachmentData(source)}
              key={source.id}
              onRemove={() => onRemoveSource?.(source.id)}
            >
              <AttachmentPreview
                className="text-foreground/75"
                fallbackIcon={<SourceIcon className="size-4" source={source} />}
              />
              <AttachmentInfo className="max-w-[220px] text-[13px] font-medium" />
              <AttachmentRemove
                className="text-foreground/55 hover:bg-background/60"
                label={`Remove ${source.title}`}
              />
            </Attachment>
          ))
        )}
        {images.map((file) => (
          <ComposerImageAttachment
            attachment={file}
            key={file.id}
            onRemove={() => attachments.remove(file.id)}
          />
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

function ComposerImageAttachment({
  attachment,
  onRemove,
}: {
  attachment: ReturnType<typeof usePromptInputAttachments>["files"][number];
  onRemove: () => void;
}) {
  const label = getAttachmentLabel(attachment);

  return (
    <AttachmentHoverCard>
      <AttachmentHoverCardTrigger asChild>
        <div className="w-fit">
          <Attachment
            className="rounded-2xl bg-muted/55 px-2.5 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]"
            data={attachment}
            onRemove={onRemove}
          >
            <div className="relative size-5 shrink-0">
              <div className="absolute inset-0 transition-opacity group-hover:opacity-0">
                <AttachmentPreview />
              </div>
              <AttachmentRemove
                className="absolute inset-0 text-foreground/55 hover:bg-background/60"
                label={`Remove ${label}`}
              />
            </div>
            <AttachmentInfo className="max-w-[180px] text-[13px] font-medium" />
          </Attachment>
        </div>
      </AttachmentHoverCardTrigger>
      <AttachmentHoverCardContent>
        <div className="space-y-3">
          {attachment.url ? (
            <div className="flex max-h-96 w-80 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
              <img
                alt={label}
                className="max-h-full max-w-full object-contain"
                height={384}
                src={attachment.url}
                width={320}
              />
            </div>
          ) : null}
          <div className="space-y-1 px-0.5">
            <h4 className="font-semibold text-sm leading-none">{label}</h4>
            {attachment.mediaType ? (
              <p className="font-mono text-muted-foreground text-xs">
                {attachment.mediaType}
              </p>
            ) : null}
          </div>
        </div>
      </AttachmentHoverCardContent>
    </AttachmentHoverCard>
  );
}

function ComposerAddImageButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      aria-disabled={disabled || undefined}
      className={cn(
        "size-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
        disabled && "pointer-events-none opacity-50",
      )}
      onClick={() => {
        if (!disabled) {
          attachments.openFileDialog();
        }
      }}
      size="icon-sm"
      tooltip="Add image"
      type="button"
      variant="ghost"
    >
      <ImageIcon className="size-4" />
      <span className="sr-only">Add image</span>
    </PromptInputButton>
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
