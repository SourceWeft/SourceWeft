import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import type { FileUIPart } from "ai";
import {
  ArrowUp,
  Brain,
  Globe,
  Image as ImageIcon,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { toast } from "sonner";
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
  PromptCommandIcon,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sourceweft/ui-web/components/ui/select";
import { Switch } from "@sourceweft/ui-web/components/ui/switch";
import {
  AGENT_TOOL_NAMES,
  getAgentToolSlashCommand,
  hasAgentToolCapability,
  isAgentToolEnabledByDefault,
} from "@sourceweft/agent-tool-registry";
import type {
  CapabilityCatalogCommand,
  CapabilityCatalogTool,
  CapabilityToolOption,
  SkillOption,
  ThreadInvocationRequest,
} from "@sourceweft/sdk";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { RawImage } from "../../../../_components/raw-image";
import {
  getPromptInputActionIcon,
  getSerializableActionIcon,
  type PromptInputActionIconPayload,
} from "../action-icons";
import type { SourceItem } from "../source-types";
import { SourceIcon, toAttachmentData } from "./source-rendering";
import {
  buildCapabilityOptionToolsSelection,
  buildCapabilityToolToggleSelection,
  buildComposerToolsSelection,
  buildSkillOptionToolsSelection,
  getConnectorAgentToolNames,
  isCapabilityToolVisibleInComposerOptions,
  isSkillViable,
  mergeChatToolsSelection,
  skillActivatedToolNames,
  skillSupportsConnector,
  SKILL_SELECTION_LIMIT_MESSAGE,
  thinkingEffortOptions,
  toggleSkillSelection,
} from "./tool-selection";
import type {
  ChatSendInput,
  ChatSkillItem,
  ChatToolName,
  ChatToolSelection,
  ChatToolsSelection,
  CapabilityCatalog,
  ImageModelCapabilities,
  PromptThinkingCapabilities,
  PromptThinkingSettings,
  ThinkingEffort,
} from "./types";
import {
  buildSkillSlashCommandFamilies,
  capabilityCommandDisplayLabel,
  isCapabilityCatalogSlashCommand,
} from "./capability-slash-command";
import {
  composerOptionsStatesEqual,
  EMPTY_COMPOSER_OPTIONS,
  normalizeComposerOptionsState,
  type ComposerOptionsState,
  type ComposerOptionOverrides,
  type ComposerOptionValue,
  type ComposerToolEnabledOverrides,
} from "./composer-options";

type ComposerSlashCommandMeta =
  | {
      kind: "tool-command";
      tool: ChatToolName;
    }
  | {
      command: CapabilityCatalogCommand;
      kind: "capability-tool-command";
      tool?: CapabilityCatalogTool;
    }
  | {
      command: CapabilityCatalogCommand;
      kind: "capability-skill-command";
      skill: ChatSkillItem;
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
    return (
      getAgentToolSlashCommand(
        command.toolName ?? normalized.replace(/^\//, ""),
      )?.displayName ?? normalized
    );
  }
  const name =
    command.commandName ??
    normalized.replace(/^\//, "").split(":")[0] ??
    normalized;
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

function getCapabilityCommandIcon(
  command: Pick<CapabilityCatalogCommand, "iconName" | "iconTone"> | undefined,
): PromptInputActionIconPayload {
  return command?.iconName
    ? {
        iconName: command.iconName,
        ...(command.iconTone ? { iconTone: command.iconTone } : {}),
      }
    : {};
}

function createPromptCommandMarker(input: {
  kind: "skill" | "tool";
  label?: string;
  value: string;
}) {
  const normalizedValue = input.value.startsWith("/")
    ? input.value
    : `/${input.value}`;
  const prefix = input.kind === "tool" ? "tool" : "skills";
  const markerValue = encodeURIComponent(normalizedValue.replace(/^\//, ""));
  const label = escapeMarkerLabel(input.label?.trim() || normalizedValue);
  return `[${prefix}:${markerValue}](${label})`;
}

function escapeMarkerLabel(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("]", "\\]")
    .replaceAll(")", "\\)");
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
      kind: "skill";
      skill: ChatSkillItem;
    }
  | {
      arguments: string;
      kind: "tool-command";
      toolName: string;
      name: `/${string}`;
    }
  | {
      arguments: string;
      displayName: string;
      kind: "capability-skill-command";
      name: `/${string}`;
      skill: ChatSkillItem;
    }
  | {
      arguments: string;
      kind: "capability-tool-invocation";
      name: `/${string}`;
      selectableId: string;
      toolName: string;
    };

type ComposerOptionDescriptor = Pick<
  CapabilityToolOption,
  "id" | "title" | "description" | "valueType" | "defaultValue" | "values"
>;

function connectorOptionSummary(enabled: boolean, connectorId: string | null) {
  if (!connectorId) {
    return "Unavailable";
  }
  return enabled ? "On" : "Off";
}

function normalizeSlashValue(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeCapabilityCommandLookup(value: string) {
  return value.trim().replace(/^\//, "").toLowerCase();
}

function primaryCapabilityCommandValue(command: CapabilityCatalogCommand) {
  const primary =
    command.aliases.find((alias) => alias.trim().length > 0) ??
    command.action.targetId ??
    command.contributionId;
  return normalizeSlashValue(primary);
}

function capabilityCommandLookups(command: CapabilityCatalogCommand) {
  return [command.action.targetId, command.contributionId, ...command.aliases]
    .map(normalizeCapabilityCommandLookup)
    .filter(Boolean);
}

function isWebAccessToolName(toolName: string) {
  return (
    toolName === AGENT_TOOL_NAMES.webSearch ||
    toolName === AGENT_TOOL_NAMES.webFetch
  );
}

function capabilityOptionValueKey(value: ComposerOptionValue | undefined) {
  return value === undefined ? "" : `${typeof value}:${String(value)}`;
}

function capabilityOptionValueLabel(
  option: ComposerOptionDescriptor,
  value: ComposerOptionValue | undefined,
) {
  const configured = option.values.find(
    (candidate) => candidate.value === value,
  );
  if (configured?.label) {
    return configured.label;
  }
  if (typeof value === "boolean") {
    return value ? "On" : "Off";
  }
  return value === undefined ? "Default" : String(value);
}

function capabilityOptionDefaultValue(option: ComposerOptionDescriptor) {
  if (option.defaultValue !== undefined) {
    return option.defaultValue;
  }
  return option.valueType === "boolean" ? false : undefined;
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
  capabilityCatalog,
  onRemoveSource,
  onSkillSelectionChange,
  submitDisabled = false,
  searchEnabled = false,
  onSearchEnabledChange,
  thinkingCapabilities,
  thinkingSettings = { mode: "auto" as const, effort: "medium" as const },
  onThinkingSettingsChange,
  imageCapabilities,
  imageModelAvailable = false,
  imageModelAlias,
  notionConnectorId = null,
  activeConnectorIds,
  connectorToolsEnabled = {},
  disabledToolNames = [],
  onDisabledToolNamesChange,
  onStopStreaming,
  isStopping = false,
  composerOptions = EMPTY_COMPOSER_OPTIONS,
  onComposerOptionsChange,
}: {
  isEditing?: boolean;
  placeholder?: string;
  onSubmit?: (
    message: PromptInputMessage,
    tools?: ChatToolsSelection,
    command?: ChatSendInput["command"],
    skillIds?: string[],
    content?: string,
    invocation?: ChatSendInput["invocation"],
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
  capabilityCatalog?: CapabilityCatalog | null;
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
  activeConnectorIds?: Record<string, string | null>;
  connectorToolsEnabled?: Record<string, boolean>;
  disabledToolNames?: ChatToolName[];
  onDisabledToolNamesChange?: (toolNames: ChatToolName[]) => void;
  onStopStreaming?: () => void;
  isStopping?: boolean;
  composerOptions?: ComposerOptionsState;
  onComposerOptionsChange?: (options: ComposerOptionsState) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [, setDraftText] = useState(initialInput);
  const [draftSegments, setDraftSegments] = useState<PromptInputSegment[]>([]);
  const normalizedComposerOptions = useMemo(
    () => normalizeComposerOptionsState(composerOptions),
    [composerOptions],
  );
  const [capabilityOptionOverrides, setCapabilityOptionOverrides] =
    useState<ComposerOptionOverrides>(
      normalizedComposerOptions.capabilityOptionOverrides,
    );
  const [skillOptionOverrides, setSkillOptionOverrides] =
    useState<ComposerOptionOverrides>(
      normalizedComposerOptions.skillOptionOverrides,
    );
  const [capabilityToolEnabledOverrides, setCapabilityToolEnabledOverrides] =
    useState<ComposerToolEnabledOverrides>(
      normalizedComposerOptions.capabilityToolEnabledOverrides,
    );
  const activeComposerOptions = useMemo<ComposerOptionsState>(
    () => ({
      capabilityOptionOverrides,
      capabilityToolEnabledOverrides,
      skillOptionOverrides,
    }),
    [
      capabilityOptionOverrides,
      capabilityToolEnabledOverrides,
      skillOptionOverrides,
    ],
  );
  const normalizedComposerOptionsKey = useMemo(
    () => JSON.stringify(normalizedComposerOptions),
    [normalizedComposerOptions],
  );
  const [composerSessionKey, setComposerSessionKey] = useState(0);
  const previousEditingRef = useRef(isEditing);
  const lastEmittedComposerOptionsRef = useRef<ComposerOptionsState>(
    normalizedComposerOptions,
  );
  const skipNextComposerOptionsEmitRef = useRef(false);
  const disabledToolNameSet = useMemo(
    () => new Set(disabledToolNames),
    [disabledToolNames],
  );
  const resolvedConnectorIds: Record<string, string | null> = {
    ...activeConnectorIds,
    ...(notionConnectorId ? { notion: notionConnectorId } : {}),
  };
  const connectorTypes = Object.keys(resolvedConnectorIds).filter(
    (type) => resolvedConnectorIds[type] !== null,
  );
  const mentionSources = useMemo(
    () =>
      allSources.filter((source) =>
        selectedSources.every((selected) => selected.id !== source.id),
      ),
    [allSources, selectedSources],
  );
  const effectiveSelectedSkillIds = useMemo(
    () =>
      selectedSkillIds.filter((skillId) => {
        const skill = availableSkills.find((item) => item.id === skillId);
        if (!skill) return true;
        // Filter out skills whose activated tools are all disabled
        if (!isSkillViable(skill, disabledToolNameSet)) return false;
        // Filter skills with connector tools that are disabled
        for (const connectorType of connectorTypes) {
          if (
            !connectorToolsEnabled[connectorType] &&
            skillSupportsConnector(skill, connectorType)
          ) {
            return false;
          }
        }
        return true;
      }),
    [
      availableSkills,
      connectorToolsEnabled,
      connectorTypes,
      disabledToolNames,
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
  const activeSlashSkills = useMemo(
    () =>
      availableSkills.filter((skill) => effectiveSelectedSkillIdSet.has(skill.id)),
    [availableSkills, effectiveSelectedSkillIdSet],
  );
  const capabilityCatalogTools = useMemo(
    () => capabilityCatalog?.tools ?? [],
    [capabilityCatalog],
  );
  const visibleCapabilityTools = useMemo(
    () =>
      capabilityCatalogTools.filter((tool) =>
        isCapabilityToolVisibleInComposerOptions(tool),
      ),
    [capabilityCatalogTools],
  );
  const visibleCapabilityToolNameSet = useMemo(
    () => new Set(visibleCapabilityTools.map((tool) => tool.toolName)),
    [visibleCapabilityTools],
  );
  const capabilityToolByName = useMemo(() => {
    const map = new Map<string, CapabilityCatalogTool>();
    for (const tool of capabilityCatalogTools) {
      map.set(tool.toolName, tool);
    }
    return map;
  }, [capabilityCatalogTools]);
  const capabilityCommands = useMemo(
    () => capabilityCatalog?.commands ?? [],
    [capabilityCatalog],
  );
  const capabilityCommandByLookup = useMemo(() => {
    const map = new Map<string, CapabilityCatalogCommand>();
    for (const command of capabilityCommands) {
      if (!isCapabilityCatalogSlashCommand(command)) {
        continue;
      }
      if (
        command.action.kind === "tool" &&
        isWebAccessToolName(command.action.targetId) &&
        !searchEnabled
      ) {
        continue;
      }
      for (const lookup of capabilityCommandLookups(command)) {
        map.set(lookup, command);
      }
    }
    return map;
  }, [capabilityCommands, searchEnabled]);
  const availableSkillByName = useMemo(() => {
    const map = new Map<string, ChatSkillItem>();
    for (const skill of availableSkills) {
      map.set(skill.name.toLowerCase(), skill);
      map.set(skill.slug.toLowerCase(), skill);
    }
    return map;
  }, [availableSkills]);
  const activeSlashSkillByName = useMemo(() => {
    const map = new Map<string, ChatSkillItem>();
    for (const skill of activeSlashSkills) {
      map.set(skill.name.toLowerCase(), skill);
      map.set(skill.slug.toLowerCase(), skill);
    }
    return map;
  }, [activeSlashSkills]);
  const capabilitySkillCommandBySkillId = useMemo(() => {
    const map = new Map<string, CapabilityCatalogCommand>();
    for (const command of capabilityCommands) {
      if (
        command.action.kind !== "skill" ||
        !isCapabilityCatalogSlashCommand(command)
      ) {
        continue;
      }
      const skill = activeSlashSkillByName.get(
        command.action.targetId.toLowerCase(),
      );
      if (skill) {
        map.set(skill.id, command);
      }
    }
    return map;
  }, [activeSlashSkillByName, capabilityCommands]);
  const builtinSkills = useMemo(
    () => availableSkills.filter((skill) => skill.sourceType === "builtin"),
    [availableSkills],
  );
  const builtinSkillsWithOptions = useMemo(
    () => builtinSkills.filter((skill) => (skill.options?.length ?? 0) > 0),
    [builtinSkills],
  );
  const builtinSkillWithOptionsIdSet = useMemo(
    () => new Set(builtinSkillsWithOptions.map((skill) => skill.id)),
    [builtinSkillsWithOptions],
  );
  const capabilityToolsWithOptions = useMemo(
    () =>
      visibleCapabilityTools.filter((tool) =>
        tool.options.some((option) => option.target?.path),
      ),
    [visibleCapabilityTools],
  );
  const capabilityOptionOverrideCount = useMemo(
    () =>
      Object.entries(capabilityOptionOverrides).reduce(
        (count, [toolName, toolOptions]) =>
          !visibleCapabilityToolNameSet.has(toolName)
            ? count
            : count +
              Object.values(toolOptions).filter((value) => value !== undefined)
                .length,
        0,
      ),
    [capabilityOptionOverrides, visibleCapabilityToolNameSet],
  );
  const capabilityToolToggleChangedCount = useMemo(
    () =>
      visibleCapabilityTools.filter((tool) => {
        const override = capabilityToolEnabledOverrides[tool.toolName];
        if (override !== undefined) {
          return true;
        }
        return (
          disabledToolNameSet.has(tool.toolName as ChatToolName) &&
          isAgentToolEnabledByDefault(tool.toolName)
        );
      }).length,
    [
      visibleCapabilityTools,
      capabilityToolEnabledOverrides,
      disabledToolNameSet,
    ],
  );
  const skillOptionOverrideCount = useMemo(
    () =>
      Object.entries(skillOptionOverrides).reduce(
        (count, [skillId, options]) =>
          !builtinSkillWithOptionsIdSet.has(skillId)
            ? count
            : count +
              Object.values(options).filter((value) => value !== undefined)
                .length,
        0,
      ),
    [builtinSkillWithOptionsIdSet, skillOptionOverrides],
  );

  const connectorToolChanged = connectorTypes.some(
    (type) => connectorToolsEnabled[type] === false,
  );
  const optionCount =
    (connectorToolChanged ? 1 : 0) +
    (selectedMcpInstallIds.length > 0 || selectedMcpToolIds.length > 0
      ? 1
      : 0) +
    (thinkingSettings.mode !== "off" && thinkingSettings.mode !== "auto"
      ? 1
      : 0) +
    skillOptionOverrideCount +
    capabilityToolToggleChangedCount +
    capabilityOptionOverrideCount;

  const supportsThinking = thinkingCapabilities?.supportsThinking === true;
  const activeThinkingSettings = supportsThinking
    ? thinkingSettings
    : { mode: "auto" as const, effort: "medium" as const };
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

  const slashCommandOptions = useMemo<PromptInputSlashCommand[]>(() => {
    // Dynamic connector tool commands — iterates all active connector types
    const connectorToolCommands: PromptInputSlashCommand[] =
      connectorTypes.flatMap((connectorType) => {
        const toolNames = getConnectorAgentToolNames(connectorType);
        if (toolNames.length === 0) return [];
        const childCommands = toolNames.flatMap((toolName) => {
          const slash = getAgentToolSlashCommand(toolName);
          return slash
            ? [
                {
                  description: slash.description,
                  group: connectorType,
                  id: `tool-command:${toolName}`,
                  ...getPromptInputActionIcon(toolName),
                  kind: "tool" as const,
                  label: slash.displayName,
                  meta: {
                    kind: "tool-command",
                    tool: toolName as ChatToolName,
                  } satisfies ComposerSlashCommandMeta,
                  value: `/${toolName as ChatToolName}`,
                },
              ]
            : [];
        });
        if (childCommands.length === 0) return [];
        const firstIconTool = toolNames[0];
        return [
          {
            children: childCommands,
            description: `Use ${connectorType} tools`,
            group: "Tools",
            id: `tool-group:${connectorType}`,
            ...(firstIconTool ? getPromptInputActionIcon(firstIconTool) : {}),
            kind: "tool" as const,
            label:
              connectorType.charAt(0).toUpperCase() + connectorType.slice(1),
            value: `/${connectorType}`,
          },
        ];
      });
    const allConnectorCommands: PromptInputSlashCommand[] = [
      ...connectorToolCommands,
    ];
    const capabilityCommandOptions: PromptInputSlashCommand[] = [];
    for (const command of capabilityCommands) {
      if (!isCapabilityCatalogSlashCommand(command)) {
        continue;
      }
      if (
        command.action.kind === "tool" &&
        isWebAccessToolName(command.action.targetId) &&
        !searchEnabled
      ) {
        continue;
      }
      const value = primaryCapabilityCommandValue(command);
      if (command.action.kind === "tool") {
        const tool = capabilityToolByName.get(command.action.targetId);
        capabilityCommandOptions.push({
          description: tool?.description,
          group: command.category ?? "Tools",
          id: `capability-command:${command.id}`,
          ...getPromptInputActionIcon(command.action.targetId),
          kind: "tool" as const,
          label: capabilityCommandDisplayLabel(command),
          meta: {
            command,
            kind: "capability-tool-command",
            ...(tool ? { tool } : {}),
          } satisfies ComposerSlashCommandMeta,
          value,
        });
        continue;
      }
    }
    const skillFamilyCommands = buildSkillSlashCommandFamilies({
      commands: capabilityCommands,
      skills: activeSlashSkills,
    }).map((item): PromptInputSlashCommand => {
      if (item.kind === "capability-skill-command") {
        return {
          description: item.skill.description,
          group: item.command.category ?? "Skills",
          id: `capability-command:${item.command.id}`,
          ...getCapabilityCommandIcon(item.command),
          kind: "skill" as const,
          label:
            capabilityCommandDisplayLabel(item.command) ||
            item.skill.displayName,
          meta: {
            command: item.command,
            kind: "capability-skill-command",
            skill: item.skill,
          } satisfies ComposerSlashCommandMeta,
          value: primaryCapabilityCommandValue(item.command),
        };
      }
      return {
        description: item.skill.description,
        group: "Skills",
        id: `skill:${item.skill.id}`,
        kind: "skill" as const,
        label: item.skill.displayName,
        meta: {
          kind: "skill",
          skill: item.skill,
        } satisfies ComposerSlashCommandMeta,
        value: `/${item.skill.slug}`,
      };
    });
    return [
      ...capabilityCommandOptions,
      ...allConnectorCommands,
      ...skillFamilyCommands,
    ];
  }, [
    activeSlashSkills,
    capabilityCommands,
    capabilityToolByName,
    connectorTypes.join(","),
    searchEnabled,
  ]);
  function supportsSkillSlash(
    skill: ChatSkillItem | undefined,
  ): skill is ChatSkillItem {
    return Boolean(
      skill && skill.slash !== false && skill.slashConfig?.enabled !== false,
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
          ...(commandKindForPromptInput(command) === "tool"
            ? getSerializableActionIcon(canonicalName)
            : {}),
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
      ...(initialInput
        ? [{ text: ` ${initialInput}`, type: "text" } as const]
        : []),
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

  function updateToolEnabled(toolName: ChatToolName, next: boolean) {
    const nextDisabledTools = next
      ? disabledToolNames.filter((candidate) => candidate !== toolName)
      : Array.from(new Set([...disabledToolNames, toolName]));
    onDisabledToolNamesChange?.(nextDisabledTools);
    if (!next) {
      // Remove skills whose activated tools are all now disabled
      const newDisabledSet = new Set(nextDisabledTools);
      const remainingSkillIds = selectedSkillIds.filter((skillId) => {
        const skill = availableSkills.find((item) => item.id === skillId);
        return !skill || isSkillViable(skill, newDisabledSet);
      });
      if (remainingSkillIds.length !== selectedSkillIds.length) {
        onSkillSelectionChange?.(remainingSkillIds);
      }
    }
  }

  function updateSkillSelected(skill: ChatSkillItem, next: boolean) {
    if (next) {
      const activatedTools = new Set(skillActivatedToolNames(skill));
      if (activatedTools.size > 0) {
        const nextDisabledTools = disabledToolNames.filter(
          (toolName) => !activatedTools.has(toolName),
        );
        if (nextDisabledTools.length !== disabledToolNames.length) {
          onDisabledToolNamesChange?.(nextDisabledTools);
        }
      }
      const { skillIds, wasLimited } = toggleSkillSelection({
        currentSkillIds: selectedSkillIds,
        selected: true,
        skillId: skill.id,
      });
      if (wasLimited) {
        toast.info(SKILL_SELECTION_LIMIT_MESSAGE);
        return;
      }
      onSkillSelectionChange?.(skillIds);
      return;
    }

    onSkillSelectionChange?.(
      selectedSkillIds.filter((skillId) => skillId !== skill.id),
    );
  }

  function getCapabilityToolEnabled(tool: CapabilityCatalogTool) {
    const override = capabilityToolEnabledOverrides[tool.toolName];
    if (override !== undefined) {
      return override;
    }
    if (disabledToolNameSet.has(tool.toolName as ChatToolName)) {
      return false;
    }
    return isAgentToolEnabledByDefault(tool.toolName);
  }

  function updateCapabilityToolEnabled(
    tool: CapabilityCatalogTool,
    next: boolean,
  ) {
    const defaultEnabled = isAgentToolEnabledByDefault(tool.toolName);
    setCapabilityToolEnabledOverrides((current) => {
      const updated = { ...current };
      if (next === defaultEnabled) {
        delete updated[tool.toolName];
      } else {
        updated[tool.toolName] = next;
      }
      return updated;
    });

    if (
      defaultEnabled ||
      next ||
      disabledToolNameSet.has(tool.toolName as ChatToolName)
    ) {
      updateToolEnabled(tool.toolName as ChatToolName, next);
    }
  }

  function resetCapabilityToolEnabled(tool: CapabilityCatalogTool) {
    setCapabilityToolEnabledOverrides((current) => {
      if (current[tool.toolName] === undefined) {
        return current;
      }
      const updated = { ...current };
      delete updated[tool.toolName];
      return updated;
    });

    if (isAgentToolEnabledByDefault(tool.toolName)) {
      updateToolEnabled(tool.toolName as ChatToolName, true);
      return;
    }

    if (disabledToolNameSet.has(tool.toolName as ChatToolName)) {
      onDisabledToolNamesChange?.(
        disabledToolNames.filter((toolName) => toolName !== tool.toolName),
      );
    }
  }

  function updateConnectorToolsEnabled(connectorType: string, next: boolean) {
    const toolNames = getConnectorAgentToolNames(connectorType);
    const nextDisabledTools: ChatToolName[] = next
      ? disabledToolNames.filter(
          (toolName) => !hasAgentToolCapability(toolName, connectorType),
        )
      : (Array.from(
          new Set([
            ...disabledToolNames,
            ...(toolNames as readonly ChatToolName[]),
          ]),
        ) as ChatToolName[]);
    onDisabledToolNamesChange?.(nextDisabledTools);
    if (!next) {
      const remainingSkillIds = selectedSkillIds.filter((skillId) => {
        const skill = availableSkills.find((item) => item.id === skillId);
        return !skill || !skillSupportsConnector(skill, connectorType);
      });
      if (remainingSkillIds.length !== selectedSkillIds.length) {
        onSkillSelectionChange?.(remainingSkillIds);
      }
    }
  }

  function getCapabilityOptionValues(
    tool: CapabilityCatalogTool,
    option: CapabilityToolOption,
  ) {
    const configuredValues = option.values ?? [];
    if (tool.toolName !== AGENT_TOOL_NAMES.generateImage) {
      return configuredValues;
    }
    const supportedValues =
      option.id === "aspectRatio"
        ? imageCapabilities?.controls?.aspectRatio?.values
        : option.id === "quality"
          ? imageCapabilities?.controls?.quality?.values
          : option.id === "style"
            ? imageCapabilities?.controls?.style?.values
            : undefined;
    if (!supportedValues?.length) {
      return configuredValues;
    }
    const supported = new Set<string>(supportedValues as readonly string[]);
    return configuredValues.filter(
      (candidate) =>
        typeof candidate.value !== "string" || supported.has(candidate.value),
    );
  }

  function getSkillOptionValues(option: SkillOption) {
    const configuredValues = option.values ?? [];
    if (option.target.toolName !== AGENT_TOOL_NAMES.generateImage) {
      return configuredValues;
    }
    const targetConfigKey = option.target.path.split(".").at(-1);
    const supportedValues =
      targetConfigKey === "aspectRatio"
        ? imageCapabilities?.controls?.aspectRatio?.values
        : targetConfigKey === "quality"
          ? imageCapabilities?.controls?.quality?.values
          : targetConfigKey === "style"
            ? imageCapabilities?.controls?.style?.values
            : undefined;
    if (!supportedValues?.length) {
      return configuredValues;
    }
    const supported = new Set<string>(supportedValues as readonly string[]);
    return configuredValues.filter(
      (candidate) =>
        typeof candidate.value !== "string" || supported.has(candidate.value),
    );
  }

  function getCapabilityOptionValue(
    tool: CapabilityCatalogTool,
    option: CapabilityToolOption,
  ) {
    return (
      capabilityOptionOverrides[tool.toolName]?.[option.id] ??
      capabilityOptionDefaultValue(option)
    );
  }

  function getSkillOptionValue(skill: ChatSkillItem, option: SkillOption) {
    return (
      skillOptionOverrides[skill.id]?.[option.id] ??
      capabilityOptionDefaultValue(option)
    );
  }

  function updateCapabilityOption(
    tool: CapabilityCatalogTool,
    option: CapabilityToolOption,
    value: ComposerOptionValue,
  ) {
    setCapabilityOptionOverrides((current) => {
      const defaultValue = capabilityOptionDefaultValue(option);
      const toolOptions = { ...(current[tool.toolName] ?? {}) };
      if (value === defaultValue) {
        delete toolOptions[option.id];
      } else {
        toolOptions[option.id] = value;
      }
      const next = { ...current };
      if (Object.values(toolOptions).some((item) => item !== undefined)) {
        next[tool.toolName] = toolOptions;
      } else {
        delete next[tool.toolName];
      }
      return next;
    });
  }

  function updateSkillOption(
    skill: ChatSkillItem,
    option: SkillOption,
    value: ComposerOptionValue,
  ) {
    setSkillOptionOverrides((current) => {
      const defaultValue = capabilityOptionDefaultValue(option);
      const skillOptions = { ...(current[skill.id] ?? {}) };
      if (value === defaultValue) {
        delete skillOptions[option.id];
      } else {
        skillOptions[option.id] = value;
      }
      const next = { ...current };
      if (Object.values(skillOptions).some((item) => item !== undefined)) {
        next[skill.id] = skillOptions;
      } else {
        delete next[skill.id];
      }
      return next;
    });
  }

  function resetCapabilityToolOptions(tool: CapabilityCatalogTool) {
    setCapabilityOptionOverrides((current) => {
      if (!current[tool.toolName]) {
        return current;
      }
      const next = { ...current };
      delete next[tool.toolName];
      return next;
    });
  }

  function resetSkillOptions(skill: ChatSkillItem) {
    setSkillOptionOverrides((current) => {
      if (!current[skill.id]) {
        return current;
      }
      const next = { ...current };
      delete next[skill.id];
      return next;
    });
  }

  function buildCommandSkillIds(skill: ChatSkillItem | undefined) {
    return skill ? [skill.id] : [];
  }

  function resolveTokenCommand(
    commandName: string,
    argumentsText = "",
  ): ResolvedComposerCommand | null {
    const normalizedCommandName = normalizeSlashValue(commandName);
    const normalizedToolName = normalizedCommandName
      .replace(/^\//, "")
      .toLowerCase();
    const args = argumentsText.trim();
    const capabilityCommand = capabilityCommandByLookup.get(normalizedToolName);
    if (capabilityCommand?.action.kind === "tool") {
      const name = primaryCapabilityCommandValue(
        capabilityCommand,
      ) as `/${string}`;
      if (capabilityCommand.hasWorkflow) {
        return {
          arguments: args,
          kind: "tool-command",
          name,
          toolName: capabilityCommand.action.targetId,
        };
      }
      return {
        arguments: args,
        kind: "capability-tool-invocation",
        name,
        selectableId: capabilityCommand.id,
        toolName: capabilityCommand.action.targetId,
      };
    }
    if (capabilityCommand?.action.kind === "skill") {
      const skill = activeSlashSkillByName.get(
        capabilityCommand.action.targetId.toLowerCase(),
      );
      if (skill && skill.slashConfig?.enabled !== false) {
        return {
          arguments: args,
          displayName: capabilityCommand.title || skill.displayName,
          kind: "capability-skill-command",
          name: primaryCapabilityCommandValue(
            capabilityCommand,
          ) as `/${string}`,
          skill,
        };
      }
    }

    // Check all active connector types for matching tool names
    for (const connectorType of connectorTypes) {
      const toolNames = getConnectorAgentToolNames(connectorType);
      const matchedToolName = toolNames.find(
        (toolName) => toolName.toLowerCase() === normalizedToolName,
      );
      if (matchedToolName) {
        return {
          arguments: args,
          kind: "tool-command",
          name: `/${matchedToolName}`,
          toolName: matchedToolName as ChatToolName,
        };
      }
    }
    const skillActivation = activeSlashSkills.find(
      (skill) =>
        normalizedCommandName.toLowerCase() ===
          `/${skill.slug}`.toLowerCase() && supportsSkillSlash(skill),
    );
    if (skillActivation) {
      return {
        arguments: args,
        kind: "skill",
        skill: skillActivation,
      };
    }

    return null;
  }

  function resolveTokenCommands(
    commands: Array<
      Extract<PromptInputSegment, { type: "command" }>["command"]
    >,
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

      if (
        (tokenCommand.kind === "skill" ||
          tokenCommand.kind === "capability-skill-command") &&
        seenSkillIds.has(tokenCommand.skill.id)
      ) {
        continue;
      }
      if (
        (tokenCommand.kind === "tool-command" ||
          tokenCommand.kind === "capability-tool-invocation") &&
        seenTools.has(tokenCommand.name)
      ) {
        continue;
      }

      if (
        tokenCommand.kind === "skill" ||
        tokenCommand.kind === "capability-skill-command"
      ) {
        seenSkillIds.add(tokenCommand.skill.id);
      } else if (
        tokenCommand.kind === "tool-command" ||
        tokenCommand.kind === "capability-tool-invocation"
      ) {
        seenTools.add(tokenCommand.name);
      }
      resolved.push(tokenCommand);
    }

    return resolved;
  }

  useEffect(() => {
    setDraftText(initialInput);
    setDraftSegments(initialPromptSegments);
  }, [initialCommand, initialInput, initialPromptSegments, inputKey]);

  useEffect(() => {
    const next = normalizeComposerOptionsState(normalizedComposerOptions);
    lastEmittedComposerOptionsRef.current = next;
    skipNextComposerOptionsEmitRef.current = true;
    setCapabilityOptionOverrides(next.capabilityOptionOverrides);
    setCapabilityToolEnabledOverrides(next.capabilityToolEnabledOverrides);
    setSkillOptionOverrides(next.skillOptionOverrides);
  }, [normalizedComposerOptionsKey]);

  useEffect(() => {
    if (skipNextComposerOptionsEmitRef.current) {
      skipNextComposerOptionsEmitRef.current = false;
      return;
    }
    if (
      composerOptionsStatesEqual(
        activeComposerOptions,
        lastEmittedComposerOptionsRef.current,
      )
    ) {
      return;
    }
    lastEmittedComposerOptionsRef.current = activeComposerOptions;
    onComposerOptionsChange?.(activeComposerOptions);
  }, [activeComposerOptions, onComposerOptionsChange]);

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
        key={`${String(inputKey ?? "composer")}:${composerSessionKey}:${initialAttachments.map((a) => a.id).join(",")}`}
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
            const markerContent =
              promptSegmentsToMarkerContent(submittedSegments);
            const userTextContent = promptSegmentsToUserText(submittedSegments);
            const tokenResolvedCommands = resolveTokenCommands(
              submittedCommandSegments.map((segment) => segment.command),
            );
            const activeCommand =
              [...tokenResolvedCommands]
                .reverse()
                .find(
                  (command) =>
                    command.kind === "skill" ||
                    command.kind === "capability-skill-command",
                ) ?? null;
            const activeToolCommand =
              activeCommand === null
                ? ([...tokenResolvedCommands]
                    .reverse()
                    .find((command) => command.kind === "tool-command") ?? null)
                : null;
            const activeToolInvocation =
              activeCommand === null && activeToolCommand === null
                ? ([...tokenResolvedCommands]
                    .reverse()
                    .find(
                      (command) =>
                        command.kind === "capability-tool-invocation",
                    ) ?? null)
                : null;
            const invokedSkillIds = [
              ...new Set(
                tokenResolvedCommands
                  .flatMap((command) =>
                    command.kind === "skill" ||
                    command.kind === "capability-skill-command"
                      ? buildCommandSkillIds(command.skill)
                      : [],
                  )
                  .filter(Boolean),
              ),
            ].slice(0, 5);
            const optionSelectedSkillIds = effectiveSelectedSkillIds.filter(
              (skillId) => {
                const skill = availableSkills.find(
                  (candidate) => candidate.id === skillId,
                );
                return !skill || skill.sourceType === "builtin";
              },
            );
            const requestSkillIds = [
              ...new Set([...optionSelectedSkillIds, ...invokedSkillIds]),
            ].slice(0, 5);
            const turnSkillIds = [
              ...new Set([...effectiveSelectedSkillIds, ...invokedSkillIds]),
            ];
            const turnSkills = availableSkills.filter((skill) =>
              turnSkillIds.includes(skill.id),
            );
            const submittedMessage = message;
            const commandRequest =
              activeCommand?.kind === "skill"
                ? {
                    arguments: userTextContent,
                    displayName: activeCommand.skill.displayName,
                    kind: "skill" as const,
                    name: `/${activeCommand.skill.slug}`,
                  }
                : activeCommand?.kind === "capability-skill-command"
                  ? {
                      arguments: userTextContent,
                      displayName: activeCommand.displayName,
                      kind: "skill" as const,
                      name: activeCommand.name,
                    }
                  : activeToolCommand?.kind === "tool-command"
                    ? {
                        arguments: userTextContent,
                        kind: "tool" as const,
                        name: activeToolCommand.name,
                        toolName: activeToolCommand.toolName,
                      }
                    : undefined;
            const invocationRequest: ThreadInvocationRequest | undefined =
              activeToolInvocation?.kind === "capability-tool-invocation"
                ? {
                    selectableId: activeToolInvocation.selectableId,
                    userInput: userTextContent,
                  }
                : undefined;
            const tools = buildComposerToolsSelection({
              disabledToolNames,
              selectedSkills: turnSkills,
              activeConnectorIds: resolvedConnectorIds,
              connectorToolsEnabled,
            });
            const toolsWithSkillOptions = mergeChatToolsSelection(
              tools,
              buildSkillOptionToolsSelection({
                selectedSkills: turnSkills,
                overrides: skillOptionOverrides,
              }),
            );
            const toolsWithCapabilityOptions = mergeChatToolsSelection(
              toolsWithSkillOptions,
              buildCapabilityOptionToolsSelection({
                catalogTools: capabilityToolsWithOptions,
                overrides: capabilityOptionOverrides,
              }),
            );
            const toolsWithCapabilityToggles = mergeChatToolsSelection(
              toolsWithCapabilityOptions,
              buildCapabilityToolToggleSelection({
                catalogTools: visibleCapabilityTools,
                overrides: capabilityToolEnabledOverrides,
              }),
            );
            const toolCommandNames = new Set(
              tokenResolvedCommands
                .filter((command) => command.kind === "tool-command")
                .map((command) => command.toolName),
            );
            const toolsWithTokenCommands: ChatToolsSelection | undefined =
              toolCommandNames.size
                ? (() => {
                    const commandTools: ChatToolsSelection = {};
                    for (const toolName of toolCommandNames) {
                      // Enable connector tools whose capability matches
                      if (hasAgentToolCapability(toolName, "notion")) {
                        const connectorTools = commandTools as Record<
                          string,
                          ChatToolSelection | undefined
                        >;
                        connectorTools[toolName] = {
                          ...(connectorTools[toolName] ?? {}),
                          ...(notionConnectorId
                            ? { connectorId: notionConnectorId }
                            : {}),
                          enabled: true,
                        };
                      } else {
                        commandTools[toolName] = {
                          ...(commandTools[toolName] ?? {}),
                          enabled: true,
                        };
                      }
                    }
                    return mergeChatToolsSelection(
                      toolsWithCapabilityToggles,
                      commandTools,
                    );
                  })()
                : toolsWithCapabilityToggles;
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
              requestSkillIds,
              markerContent,
              invocationRequest,
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
                const meta = option.meta as
                  | ComposerSlashCommandMeta
                  | undefined;
                if (!meta) {
                  return;
                }
                if (meta.kind === "tool-command") {
                  return;
                }
                if (meta.kind === "capability-tool-command") {
                  return;
                }
                if (meta.kind === "capability-skill-command") {
                  return;
                }
                if (meta.kind === "skill") {
                  return;
                }
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
                    <DropdownMenuSeparator />
                    {connectorTypes.map((connectorType) => {
                      const toolNames =
                        getConnectorAgentToolNames(connectorType);
                      if (toolNames.length === 0) return null;
                      const connectorEnabled =
                        connectorToolsEnabled[connectorType] ?? true;
                      const connectorChanged =
                        connectorEnabled !== undefined && !connectorEnabled;
                      const connectorSummary = connectorOptionSummary(
                        connectorEnabled,
                        resolvedConnectorIds[connectorType] ?? null,
                      );
                      const displayName =
                        connectorType.charAt(0).toUpperCase() +
                        connectorType.slice(1);
                      const firstToolName = toolNames[0];
                      return (
                        <Fragment key={connectorType}>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className="h-9 min-w-0 overflow-hidden rounded-lg px-2 text-xs whitespace-nowrap">
                              <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                <PromptCommandIcon
                                  className="size-3.5 shrink-0"
                                  fallbackIconName="tool"
                                  {...(firstToolName
                                    ? getPromptInputActionIcon(firstToolName)
                                    : {})}
                                />
                                <span className="shrink-0">{displayName}</span>
                                <span
                                  className={cn(
                                    "ml-auto min-w-0 max-w-[108px] truncate text-right text-muted-foreground",
                                    connectorChanged && "text-primary",
                                  )}
                                >
                                  {connectorSummary}
                                </span>
                              </span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-64 p-3">
                              <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-xs font-medium text-foreground">
                                      {displayName} tools
                                    </div>
                                  </div>
                                  <Switch
                                    checked={connectorEnabled}
                                    onCheckedChange={(checked) =>
                                      updateConnectorToolsEnabled(
                                        connectorType,
                                        Boolean(checked),
                                      )
                                    }
                                    size="sm"
                                  />
                                </div>
                                <div className="flex items-center justify-between border-border/60 border-t pt-2">
                                  <span className="truncate text-[11px] text-muted-foreground">
                                    {connectorSummary}
                                  </span>
                                  <button
                                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    onClick={() =>
                                      updateConnectorToolsEnabled(
                                        connectorType,
                                        true,
                                      )
                                    }
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
                        </Fragment>
                      );
                    })}
                    {visibleCapabilityTools.map((tool) => {
                      const toolOptions = tool.options.filter(
                        (option) => option.target?.path,
                      );
                      const overrides =
                        capabilityOptionOverrides[tool.toolName] ?? {};
                      const changedCount = Object.values(overrides).filter(
                        (value) => value !== undefined,
                      ).length;
                      const toolEnabled = getCapabilityToolEnabled(tool);
                      const toolToggleChanged =
                        capabilityToolEnabledOverrides[tool.toolName] !==
                          undefined ||
                        toolEnabled !==
                          isAgentToolEnabledByDefault(tool.toolName);
                      const summary = !toolEnabled
                        ? "Off"
                        : changedCount > 0
                          ? `${changedCount} changed`
                          : capabilityToolEnabledOverrides[tool.toolName] ===
                              true
                            ? "On"
                            : "Default";
                      const toolChanged = changedCount > 0 || toolToggleChanged;
                      return (
                        <Fragment key={tool.id}>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className="h-9 min-w-0 overflow-hidden rounded-lg px-2 text-xs whitespace-nowrap">
                              <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                <PromptCommandIcon
                                  className="size-3.5 shrink-0"
                                  fallbackIconName="tool"
                                  {...getPromptInputActionIcon(tool.toolName)}
                                />
                                <span className="min-w-0 shrink truncate">
                                  {tool.title}
                                </span>
                                <span
                                  className={cn(
                                    "ml-auto min-w-0 max-w-[96px] truncate text-right text-muted-foreground",
                                    toolChanged && "text-primary",
                                  )}
                                >
                                  {summary}
                                </span>
                              </span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-80 p-3">
                              <div className="space-y-3">
                                <div className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                                  <div className="min-w-0">
                                    <div className="text-xs font-medium text-foreground">
                                      Enable tool
                                    </div>
                                    <div className="truncate text-[11px] text-muted-foreground">
                                      {tool.description}
                                    </div>
                                  </div>
                                  <Switch
                                    checked={toolEnabled}
                                    onCheckedChange={(checked) =>
                                      updateCapabilityToolEnabled(
                                        tool,
                                        Boolean(checked),
                                      )
                                    }
                                    size="sm"
                                  />
                                </div>
                                {toolOptions.length > 0 ? (
                                  <div
                                    className={cn(
                                      "space-y-2",
                                      !toolEnabled && "opacity-60",
                                    )}
                                  >
                                    {toolOptions.map((option) => {
                                      const value = getCapabilityOptionValue(
                                        tool,
                                        option,
                                      );
                                      const values = getCapabilityOptionValues(
                                        tool,
                                        option,
                                      );
                                      const optionChanged =
                                        overrides[option.id] !== undefined;
                                      const valueLabel =
                                        capabilityOptionValueLabel(
                                          option,
                                          value,
                                        );
                                      if (option.valueType === "boolean") {
                                        return (
                                          <div
                                            className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                                            key={option.id}
                                            title={option.description}
                                          >
                                            <div className="flex min-w-0 items-center gap-1.5">
                                              <span
                                                className={cn(
                                                  "min-w-0 truncate text-xs font-medium text-foreground",
                                                  optionChanged &&
                                                    "text-primary",
                                                )}
                                              >
                                                {option.title}
                                              </span>
                                              {optionChanged ? (
                                                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                              ) : null}
                                            </div>
                                            <Switch
                                              checked={value === true}
                                              disabled={!toolEnabled}
                                              onCheckedChange={(checked) =>
                                                updateCapabilityOption(
                                                  tool,
                                                  option,
                                                  Boolean(checked),
                                                )
                                              }
                                              size="sm"
                                            />
                                          </div>
                                        );
                                      }
                                      if (values.length === 0) {
                                        return (
                                          <div
                                            className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                                            key={option.id}
                                            title={option.description}
                                          >
                                            <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                                              {option.title}
                                            </span>
                                            <span className="shrink-0 text-[11px] text-muted-foreground">
                                              Unavailable
                                            </span>
                                          </div>
                                        );
                                      }
                                      const selectedValueKey = values
                                        .map((candidate) =>
                                          capabilityOptionValueKey(
                                            candidate.value,
                                          ),
                                        )
                                        .includes(
                                          capabilityOptionValueKey(value),
                                        )
                                        ? capabilityOptionValueKey(value)
                                        : undefined;
                                      return (
                                        <div
                                          className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                                          key={option.id}
                                          title={option.description}
                                        >
                                          <div className="flex min-w-0 items-center gap-1.5">
                                            <span
                                              className={cn(
                                                "min-w-0 truncate text-xs font-medium text-foreground",
                                                optionChanged && "text-primary",
                                              )}
                                            >
                                              {option.title}
                                            </span>
                                            {optionChanged ? (
                                              <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                            ) : null}
                                          </div>
                                          <Select
                                            disabled={!toolEnabled}
                                            onValueChange={(nextValue) => {
                                              const selected = values.find(
                                                (candidate) =>
                                                  capabilityOptionValueKey(
                                                    candidate.value,
                                                  ) === nextValue,
                                              );
                                              if (!selected) {
                                                return;
                                              }
                                              updateCapabilityOption(
                                                tool,
                                                option,
                                                selected.value,
                                              );
                                            }}
                                            value={selectedValueKey}
                                          >
                                            <SelectTrigger
                                              className={cn(
                                                "h-7 w-[116px] rounded-md text-xs",
                                                optionChanged &&
                                                  "border-primary/50 text-primary",
                                              )}
                                              size="sm"
                                            >
                                              <SelectValue
                                                placeholder={valueLabel}
                                              />
                                            </SelectTrigger>
                                            <SelectContent className="max-h-64">
                                              {values.map((candidate) => (
                                                <SelectItem
                                                  className="text-xs"
                                                  key={capabilityOptionValueKey(
                                                    candidate.value,
                                                  )}
                                                  value={capabilityOptionValueKey(
                                                    candidate.value,
                                                  )}
                                                >
                                                  {candidate.label ??
                                                    String(candidate.value)}
                                                </SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="rounded-lg bg-muted/40 px-2 py-2 text-[11px] text-muted-foreground">
                                    No configurable options
                                  </div>
                                )}
                                <div className="flex items-center justify-between border-border/60 border-t pt-2">
                                  <span className="truncate text-[11px] text-muted-foreground">
                                    {summary}
                                  </span>
                                  <button
                                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    onClick={() => {
                                      resetCapabilityToolEnabled(tool);
                                      resetCapabilityToolOptions(tool);
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
                        </Fragment>
                      );
                    })}
                    {builtinSkillsWithOptions.length > 0 ? (
                      <>
                        {builtinSkillsWithOptions.map((skill) => {
                          const options = skill.options ?? [];
                          const overrides =
                            skillOptionOverrides[skill.id] ?? {};
                          const changedCount = Object.values(overrides).filter(
                            (value) => value !== undefined,
                          ).length;
                          const skillEnabled = effectiveSelectedSkillIdSet.has(
                            skill.id,
                          );
                          const skillUnavailable = !isSkillViable(
                            skill,
                            disabledToolNameSet,
                          );
                          const summary = !skillEnabled
                            ? "Off"
                            : changedCount > 0
                              ? `${changedCount} changed`
                              : "Default";
                          const skillChanged = changedCount > 0;
                          const skillCommandIcon =
                            capabilitySkillCommandBySkillId.get(skill.id);
                          return (
                            <Fragment key={skill.id}>
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger className="h-9 min-w-0 overflow-hidden rounded-lg px-2 text-xs whitespace-nowrap">
                                  <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                    <PromptCommandIcon
                                      className={cn(
                                        "size-3.5 shrink-0 text-muted-foreground",
                                        skillEnabled && "text-primary",
                                      )}
                                      fallbackIconName="skill"
                                      {...getCapabilityCommandIcon(
                                        skillCommandIcon,
                                      )}
                                    />
                                    <span
                                      className={cn(
                                        "min-w-0 shrink truncate",
                                        skillUnavailable &&
                                          "text-muted-foreground",
                                      )}
                                    >
                                      {skill.displayName}
                                    </span>
                                    <span
                                      className={cn(
                                        "ml-auto min-w-0 max-w-[96px] truncate text-right text-muted-foreground",
                                        skillChanged && "text-primary",
                                      )}
                                    >
                                      {summary}
                                    </span>
                                  </span>
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-80 p-3">
                                  <div className="space-y-3">
                                    <div className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                                      <div className="min-w-0">
                                        <div className="text-xs font-medium text-foreground">
                                          Enable skill
                                        </div>
                                        <div className="truncate text-[11px] text-muted-foreground">
                                          {skill.description}
                                        </div>
                                      </div>
                                      <Switch
                                        checked={skillEnabled}
                                        disabled={
                                          !onSkillSelectionChange ||
                                          skillUnavailable
                                        }
                                        onCheckedChange={(checked) =>
                                          updateSkillSelected(
                                            skill,
                                            Boolean(checked),
                                          )
                                        }
                                        size="sm"
                                      />
                                    </div>
                                    <div
                                      className={cn(
                                        "space-y-2",
                                        (!skillEnabled || skillUnavailable) &&
                                          "opacity-60",
                                      )}
                                    >
                                      {options.map((option) => {
                                        const value = getSkillOptionValue(
                                          skill,
                                          option,
                                        );
                                        const values =
                                          getSkillOptionValues(option);
                                        const optionChanged =
                                          overrides[option.id] !== undefined;
                                        const valueLabel =
                                          capabilityOptionValueLabel(
                                            option,
                                            value,
                                          );
                                        const disabled =
                                          !skillEnabled || skillUnavailable;
                                        if (option.valueType === "boolean") {
                                          return (
                                            <div
                                              className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                                              key={option.id}
                                              title={option.description}
                                            >
                                              <div className="flex min-w-0 items-center gap-1.5">
                                                <span
                                                  className={cn(
                                                    "min-w-0 truncate text-xs font-medium text-foreground",
                                                    optionChanged &&
                                                      "text-primary",
                                                  )}
                                                >
                                                  {option.title}
                                                </span>
                                                {optionChanged ? (
                                                  <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                                ) : null}
                                              </div>
                                              <Switch
                                                checked={value === true}
                                                disabled={disabled}
                                                onCheckedChange={(checked) =>
                                                  updateSkillOption(
                                                    skill,
                                                    option,
                                                    Boolean(checked),
                                                  )
                                                }
                                                size="sm"
                                              />
                                            </div>
                                          );
                                        }
                                        if (values.length === 0) {
                                          return (
                                            <div
                                              className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                                              key={option.id}
                                              title={option.description}
                                            >
                                              <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                                                {option.title}
                                              </span>
                                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                                Unavailable
                                              </span>
                                            </div>
                                          );
                                        }
                                        const selectedValueKey = values
                                          .map((candidate) =>
                                            capabilityOptionValueKey(
                                              candidate.value,
                                            ),
                                          )
                                          .includes(
                                            capabilityOptionValueKey(value),
                                          )
                                          ? capabilityOptionValueKey(value)
                                          : undefined;
                                        return (
                                          <div
                                            className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-1.5"
                                            key={option.id}
                                            title={option.description}
                                          >
                                            <div className="flex min-w-0 items-center gap-1.5">
                                              <span
                                                className={cn(
                                                  "min-w-0 truncate text-xs font-medium text-foreground",
                                                  optionChanged &&
                                                    "text-primary",
                                                )}
                                              >
                                                {option.title}
                                              </span>
                                              {optionChanged ? (
                                                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                              ) : null}
                                            </div>
                                            <Select
                                              disabled={disabled}
                                              onValueChange={(nextValue) => {
                                                const selected = values.find(
                                                  (candidate) =>
                                                    capabilityOptionValueKey(
                                                      candidate.value,
                                                    ) === nextValue,
                                                );
                                                if (!selected) {
                                                  return;
                                                }
                                                updateSkillOption(
                                                  skill,
                                                  option,
                                                  selected.value,
                                                );
                                              }}
                                              value={selectedValueKey}
                                            >
                                              <SelectTrigger
                                                className={cn(
                                                  "h-7 w-[116px] rounded-md text-xs",
                                                  optionChanged &&
                                                    "border-primary/50 text-primary",
                                                )}
                                                size="sm"
                                              >
                                                <SelectValue
                                                  placeholder={valueLabel}
                                                />
                                              </SelectTrigger>
                                              <SelectContent className="max-h-64">
                                                {values.map((candidate) => (
                                                  <SelectItem
                                                    className="text-xs"
                                                    key={capabilityOptionValueKey(
                                                      candidate.value,
                                                    )}
                                                    value={capabilityOptionValueKey(
                                                      candidate.value,
                                                    )}
                                                  >
                                                    {candidate.label ??
                                                      String(candidate.value)}
                                                  </SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <div className="flex items-center justify-between border-border/60 border-t pt-2">
                                      <span className="truncate text-[11px] text-muted-foreground">
                                        {summary}
                                      </span>
                                      <button
                                        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        onClick={() => resetSkillOptions(skill)}
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
                            </Fragment>
                          );
                        })}
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
                                  ...(activeThinkingSettings ?? {
                                    mode: "auto" as const,
                                    effort: "medium" as const,
                                  }),
                                  mode: "off",
                                });
                                return;
                              }

                              if (value === "auto") {
                                updateThinkingSettings({
                                  ...(activeThinkingSettings ?? {
                                    mode: "auto" as const,
                                    effort: "medium" as const,
                                  }),
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

                <PromptInputButton
                  aria-pressed={searchEnabled}
                  className={
                    searchEnabled
                      ? "rounded-xl bg-foreground text-background shadow-sm hover:bg-foreground/90 hover:text-background"
                      : "rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                  }
                  onClick={() => onSearchEnabledChange?.(!searchEnabled)}
                  size="icon-sm"
                  tooltip={{ content: "Web access", shortcut: "S" }}
                  type="button"
                  variant={searchEnabled ? "secondary" : "ghost"}
                >
                  <Globe className="size-4" />
                  <span className="sr-only">Web access</span>
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
                    <PromptInputSubmit
                      className="size-9 shrink-0 rounded-full px-0 shadow-xs"
                      disabled={isStopping}
                      onStop={isStopping ? undefined : onStopStreaming}
                      status={isStopping ? "submitted" : "streaming"}
                      title={isStopping ? "Stopping" : "Stop"}
                      type="button"
                    />
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
              <RawImage
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
