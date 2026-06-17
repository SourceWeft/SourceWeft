"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createGlobalIconElement,
  DEFAULT_GLOBAL_SKILL_ICON_NAME,
  DEFAULT_GLOBAL_TOOL_ICON_NAME,
  GlobalIcon,
  isGlobalIconTone,
  type GlobalIconName,
  type GlobalIconTone,
} from "@/components/ui/global-icon";
import { cn } from "@/lib/utils";
import type { ChatStatus, FileUIPart, SourceDocumentUIPart } from "ai";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  Monitor,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import type {
  ChangeEvent,
  ChangeEventHandler,
  ClipboardEventHandler,
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  MouseEventHandler,
  PropsWithChildren,
  ReactNode,
  RefObject,
} from "react";
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ============================================================================
// Helpers
// ============================================================================

const convertFileUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url, { credentials: "include" });
    const blob = await response.blob();
    // FileReader uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    return new Promise((resolve) => {
      const reader = new FileReader();
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onloadend = () => resolve(reader.result as string);
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};

const shouldConvertFileUrlToDataUrl = (file: FileUIPart) =>
  !file.url.startsWith("data:") &&
  (file.url.startsWith("blob:") || file.mediaType.startsWith("image/"));

const captureScreenshot = async (): Promise<File | null> => {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getDisplayMedia
  ) {
    return null;
  }

  let stream: MediaStream | null = null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: true,
    });

    video.srcObject = stream;

    // Video element uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    await new Promise<void>((resolve, reject) => {
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      video.onloadedmetadata = () => resolve();
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      video.onerror = () => reject(new Error("Failed to load screen stream"));
    });

    await video.play();

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, width, height);
    // canvas.toBlob uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      return null;
    }

    const timestamp = new Date()
      .toISOString()
      .replaceAll(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");

    return new File([blob], `screenshot-${timestamp}.png`, {
      lastModified: Date.now(),
      type: "image/png",
    });
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    video.pause();
    video.srcObject = null;
  }
};

const SOURCE_MENTION_TRIGGER_PATTERN = /(?:^|\s)@([^\s@]*)$/;
const SLASH_COMMAND_TRIGGER_PATTERN = /(?:^|\s)\/([^\s/]*)$/;
const SOURCE_MENTION_PAGE_SIZE = 20;

const getSourceMentionLabel = (title: string) => `@${title}`;

const PROMPT_MARKER_PATTERN =
  /\[(skills|skill-command|tool|source):([^\]]+)\]\(((?:\\.|[^)])*)\)/g;

const escapeMarkerLabel = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("]", "\\]").replaceAll(")", "\\)");

const createSourceMarker = (source: { id: string; title: string }) =>
  `[source:${encodeURIComponent(source.id)}](${escapeMarkerLabel(source.title)})`;

const normalizeText = (value: string) =>
  value.replaceAll("\u00a0", " ").replace(/\r\n?/g, "\n");

const uniqueStrings = (values: string[]) => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const decodeMarkerValue = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const unescapeMarkerLabel = (value: string) =>
  value.replace(/\\([\\)\]])/g, "$1");

const promptSubmitText = (content: string) => {
  let text = "";
  let lastIndex = 0;
  PROMPT_MARKER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PROMPT_MARKER_PATTERN.exec(content)) !== null) {
    text += content.slice(lastIndex, match.index);
    const rawKind = match[1];
    if (rawKind === "source") {
      const decodedValue = decodeMarkerValue(match[2] ?? "");
      const label = unescapeMarkerLabel(match[3] ?? "");
      text += `@${label || decodedValue}`;
    }
    lastIndex = PROMPT_MARKER_PATTERN.lastIndex;
  }

  text += content.slice(lastIndex);
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
};

const hasPromptSubmitText = (content: string) =>
  promptSubmitText(content).length > 0;

const isPromptAtomElement = (node: Node) =>
  node instanceof HTMLElement &&
  (Boolean(node.dataset.sourceMentionId) ||
    Boolean(node.dataset.slashCommandValue));

const isHtmlElement = (node: Node): node is HTMLElement =>
  node instanceof HTMLElement;

const getPromptAtomText = (element: HTMLElement) => {
  const sourceId = element.dataset.sourceMentionId;
  if (sourceId) {
    const title =
      element.dataset.sourceMentionTitle ||
      element.textContent?.replace(/^@/, "") ||
      sourceId;
    return getSourceMentionLabel(title);
  }

  return (
    element.dataset.slashCommandLabel ||
    element.textContent ||
    element.dataset.slashCommandValue ||
    ""
  );
};

const getNodeIndex = (node: Node) =>
  node.parentNode
    ? Array.prototype.indexOf.call(node.parentNode.childNodes, node)
    : 0;

const getNodeTextLength = (node: Node): number => {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.textContent ?? "").length;
  }
  if (isHtmlElement(node)) {
    if (isPromptAtomElement(node)) {
      return getPromptAtomText(node).length;
    }
    if (node.tagName === "BR") {
      return 1;
    }
  }
  return Array.from(node.childNodes).reduce(
    (length, child) => length + getNodeTextLength(child),
    0,
  );
};

const getPromptDisplayText = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.textContent ?? "");
  }
  if (isHtmlElement(node)) {
    if (isPromptAtomElement(node)) {
      return getPromptAtomText(node);
    }
    if (node.tagName === "BR") {
      return "\n";
    }
  }
  return Array.from(node.childNodes).map(getPromptDisplayText).join("");
};

const getBoundaryBeforeNode = (node: Node) => ({
  node: node.parentNode ?? node,
  offset: node.parentNode ? getNodeIndex(node) : 0,
});

const getBoundaryAfterNode = (node: Node) => ({
  node: node.parentNode ?? node,
  offset: node.parentNode ? getNodeIndex(node) + 1 : node.childNodes.length,
});

const getBoundaryOffset = (
  node: Node,
  container: Node,
  containerOffset: number,
): number | null => {
  if (node === container) {
    if (node.nodeType === Node.TEXT_NODE) {
      return Math.max(
        0,
        Math.min(containerOffset, normalizeText(node.textContent ?? "").length),
      );
    }
    if (node instanceof HTMLElement && isPromptAtomElement(node)) {
      return containerOffset <= 0 ? 0 : getPromptAtomText(node).length;
    }
    return Array.from(node.childNodes)
      .slice(0, containerOffset)
      .reduce((length, child) => length + getNodeTextLength(child), 0);
  }

  if (node instanceof HTMLElement && isPromptAtomElement(node)) {
    return node.contains(container) ? getPromptAtomText(node).length : null;
  }

  let offset = 0;
  for (const child of node.childNodes) {
    if (child === container || child.contains(container)) {
      const childOffset = getBoundaryOffset(child, container, containerOffset);
      return childOffset === null ? null : offset + childOffset;
    }
    offset += getNodeTextLength(child);
  }

  return null;
};

const getCaretTextOffset = (root: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return getNodeTextLength(root);
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.endContainer)) {
    return getNodeTextLength(root);
  }

  return (
    getBoundaryOffset(root, range.endContainer, range.endOffset) ??
    getNodeTextLength(root)
  );
};

const findTextPosition = (root: HTMLElement, offset: number) => {
  const findInNode = (
    node: Node,
    remainingOffset: number,
  ): {
    node: Node;
    offset: number;
  } => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = normalizeText(node.textContent ?? "").length;
      return {
        node,
        offset: Math.max(0, Math.min(remainingOffset, length)),
      };
    }

    if (node instanceof HTMLElement && isPromptAtomElement(node)) {
      return remainingOffset <= 0
        ? getBoundaryBeforeNode(node)
        : getBoundaryAfterNode(node);
    }

    let consumed = 0;
    for (const child of node.childNodes) {
      const length = getNodeTextLength(child);
      if (remainingOffset < consumed + length) {
        return findInNode(child, remainingOffset - consumed);
      }
      if (remainingOffset === consumed + length) {
        return getBoundaryAfterNode(child);
      }
      consumed += length;
    }

    return {
      node,
      offset: node.childNodes.length,
    };
  };

  return findInNode(root, Math.max(0, offset));
};

const setCaretTextOffset = (root: HTMLElement, offset: number) => {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const position = findTextPosition(root, offset);
  const range = document.createRange();
  range.setStart(position.node, position.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const setCaretAfterNode = (node: Node) => {
  const selection = window.getSelection();
  if (!selection || !node.parentNode) {
    return;
  }

  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const replaceTextRange = (
  root: HTMLElement,
  startOffset: number,
  endOffset: number,
  fragment: DocumentFragment,
) => {
  const start = findTextPosition(root, startOffset);
  const end = findTextPosition(root, endOffset);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  range.deleteContents();
  range.insertNode(fragment);
};

const insertTextAtCaret = (root: HTMLElement, text: string) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    root.append(document.createTextNode(text));
    return;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    root.append(document.createTextNode(text));
    return;
  }

  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const closestSourceMention = (node: Node | null) =>
  node instanceof HTMLElement
    ? node.closest<HTMLElement>("[data-source-mention-id]")
    : (node?.parentElement?.closest<HTMLElement>("[data-source-mention-id]") ??
      null);

const closestSlashCommand = (node: Node | null) =>
  node instanceof HTMLElement
    ? node.closest<HTMLElement>("[data-slash-command-value]")
    : (node?.parentElement?.closest<HTMLElement>(
        "[data-slash-command-value]",
      ) ?? null);

const findPreviousNode = (node: Node | null): Node | null => {
  if (!node) {
    return null;
  }

  if (node.previousSibling) {
    let previous = node.previousSibling;
    while (previous.lastChild) {
      previous = previous.lastChild;
    }
    return previous;
  }

  return node.parentNode;
};

const findSourceMentionBeforeCaret = (root: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) {
    return null;
  }

  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    if (range.startOffset > 0) {
      return null;
    }
    return closestSourceMention(findPreviousNode(range.startContainer));
  }

  const container = range.startContainer;
  const candidate = container.childNodes.item(range.startOffset - 1);
  return closestSourceMention(candidate);
};

const findSlashCommands = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-slash-command-value]"));

const removeSlashCommands = (
  root: HTMLElement,
  predicate: (element: HTMLElement) => boolean,
) => {
  for (const command of findSlashCommands(root)) {
    if (!predicate(command)) {
      continue;
    }
    const next = command.nextSibling;
    command.remove();
    if (
      next?.nodeType === Node.TEXT_NODE &&
      next.textContent?.startsWith(" ")
    ) {
      next.textContent = next.textContent.slice(1);
    }
  }
};

export type PromptInputCommandKind = "skill" | "skill-command" | "tool";
export type PromptInputCommandIconTone = GlobalIconTone;
export type PromptInputCommandIconName = GlobalIconName;

export type PromptInputSegment =
  | {
      text: string;
      type: "text";
    }
  | {
      command: {
        iconName?: PromptInputCommandIconName;
        iconSrc?: string;
        iconTone?: PromptInputCommandIconTone;
        kind: PromptInputCommandKind;
        label?: string;
        marker: string;
        value: string;
      };
      type: "command";
    }
  | {
      meta?: string;
      sourceId: string;
      title: string;
      type: "source";
    };

export type PromptInputMentionSource = {
  id: string;
  meta?: string;
  title: string;
  type?: string;
};

export type PromptInputMentionSourcePage = {
  items: PromptInputMentionSource[];
  nextCursor?: string | null;
};

export type PromptInputMentionSourceLoader = (input: {
  cursor?: string | null;
  limit: number;
  query: string;
}) => Promise<PromptInputMentionSourcePage>;

export type PromptInputSlashCommand = {
  children?: PromptInputSlashCommand[];
  description?: string;
  disabled?: boolean;
  group?: string;
  id: string;
  icon?: ReactNode;
  iconName?: PromptInputCommandIconName;
  iconSrc?: string;
  iconTone?: PromptInputCommandIconTone;
  kind?: Exclude<PromptInputCommandKind, "skill-command">;
  label?: string;
  meta?: unknown;
  value: string;
};

type PromptInputRenderedCommand = Pick<
  PromptInputSlashCommand,
  "iconName" | "iconSrc" | "iconTone" | "label" | "value"
> & {
  id?: string;
  kind?: PromptInputCommandKind;
};

const slashCommandHasChildren = (command: PromptInputSlashCommand): boolean =>
  command.children?.some(
    (child) => child.value.trim().length > 0 || slashCommandHasChildren(child),
  ) ?? false;

const slashCommandSearchText = (command: PromptInputSlashCommand): string =>
  [
    command.value,
    command.label ?? "",
    command.description ?? "",
    command.group ?? "",
    ...(command.children?.map(slashCommandSearchText) ?? []),
  ].join(" ");

const filterSlashCommands = (
  commands: PromptInputSlashCommand[],
  query: string,
) => {
  const candidates = commands.filter(
    (command) =>
      command.value.trim().length > 0 || slashCommandHasChildren(command),
  );
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return candidates.slice(0, SOURCE_MENTION_PAGE_SIZE);
  }

  return candidates
    .filter((command) =>
      slashCommandSearchText(command).toLowerCase().includes(normalizedQuery),
    )
    .slice(0, SOURCE_MENTION_PAGE_SIZE);
};

const normalizeCommandValue = (value: string) =>
  value.startsWith("/") ? value : `/${value}`;

const commandMarkerPrefix = (kind: PromptInputCommandKind) =>
  kind === "tool"
    ? "tool"
    : kind === "skill-command"
      ? "skill-command"
      : "skills";

const createCommandMarker = (input: {
  kind: PromptInputCommandKind;
  label?: string;
  value: string;
}) => {
  const normalizedValue = normalizeCommandValue(input.value);
  const markerValue = encodeURIComponent(normalizedValue.replace(/^\//, ""));
  const label = escapeMarkerLabel(input.label?.trim() || normalizedValue);
  return `[${commandMarkerPrefix(input.kind)}:${markerValue}](${label})`;
};

const pushTextSegment = (segments: PromptInputSegment[], text: string) => {
  if (!text) {
    return;
  }

  const normalized = normalizeText(text);
  if (!normalized) {
    return;
  }

  const previous = segments.at(-1);
  if (previous?.type === "text") {
    previous.text += normalized;
    return;
  }

  segments.push({ text: normalized, type: "text" });
};

const readSegmentsFromNode = (node: Node, segments: PromptInputSegment[]) => {
  if (node.nodeType === Node.TEXT_NODE) {
    pushTextSegment(segments, node.textContent ?? "");
    return;
  }

  if (!(node instanceof HTMLElement)) {
    return;
  }

  const sourceId = node.dataset.sourceMentionId;
  if (sourceId) {
    segments.push({
      meta: node.dataset.sourceMentionMeta,
      sourceId,
      title: node.dataset.sourceMentionTitle || node.textContent || sourceId,
      type: "source",
    });
    return;
  }

  const command = node.dataset.slashCommandValue;
  if (command) {
    const iconName = node.dataset.iconName ?? node.dataset.slashCommandIconName;
    const iconTone = node.dataset.iconTone ?? node.dataset.slashCommandIconTone;
    const iconSrc = node.dataset.iconSrc ?? node.dataset.slashCommandIconSrc;
    segments.push({
      command: {
        ...(iconName ? { iconName } : {}),
        ...(iconSrc ? { iconSrc } : {}),
        ...(isGlobalIconTone(iconTone) ? { iconTone } : {}),
        kind:
          node.dataset.slashCommandKind === "tool" ||
          node.dataset.slashCommandKind === "skill" ||
          node.dataset.slashCommandKind === "skill-command"
            ? node.dataset.slashCommandKind
            : "skill",
        label: node.dataset.slashCommandLabel,
        marker:
          node.dataset.slashCommandMarker ??
          createCommandMarker({
            kind:
              node.dataset.slashCommandKind === "tool" ||
              node.dataset.slashCommandKind === "skill" ||
              node.dataset.slashCommandKind === "skill-command"
                ? node.dataset.slashCommandKind
                : "skill",
            label: node.dataset.slashCommandLabel,
            value: command,
          }),
        value: normalizeCommandValue(command),
      },
      type: "command",
    });
    return;
  }

  if (node.tagName === "BR") {
    pushTextSegment(segments, "\n");
    return;
  }

  for (const child of node.childNodes) {
    readSegmentsFromNode(child, segments);
  }
};

const readSegmentsFromElement = (root: HTMLElement) => {
  const segments: PromptInputSegment[] = [];
  for (const child of root.childNodes) {
    readSegmentsFromNode(child, segments);
  }
  return segments;
};

const parsePromptInputMarkers = (content: string) => {
  const segments: PromptInputSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  PROMPT_MARKER_PATTERN.lastIndex = 0;
  while ((match = PROMPT_MARKER_PATTERN.exec(content)) !== null) {
    pushTextSegment(segments, content.slice(lastIndex, match.index));
    const rawKind = match[1];
    const rawValue = match[2] ?? "";
    const label = unescapeMarkerLabel(match[3] ?? "");
    const decodedValue = decodeMarkerValue(rawValue);

    if (rawKind === "source") {
      segments.push({
        sourceId: decodedValue,
        title: label || decodedValue,
        type: "source",
      });
    } else {
      const kind =
        rawKind === "tool"
          ? "tool"
          : rawKind === "skill-command"
            ? "skill-command"
            : "skill";
      const value = normalizeCommandValue(decodedValue);
      segments.push({
        command: {
          kind,
          ...(label ? { label } : {}),
          marker: createCommandMarker({
            kind,
            ...(label ? { label } : {}),
            value,
          }),
          value,
        },
        type: "command",
      });
    }

    lastIndex = PROMPT_MARKER_PATTERN.lastIndex;
  }

  pushTextSegment(segments, content.slice(lastIndex));
  return segments;
};

const serializePromptSegments = (segments: PromptInputSegment[]) =>
  segments
    .map((segment) =>
      segment.type === "source"
        ? createSourceMarker({ id: segment.sourceId, title: segment.title })
        : segment.type === "command"
          ? segment.command.marker
          : segment.text,
    )
    .join("");

const mentionedSourceIdsFromSegments = (segments: PromptInputSegment[]) =>
  uniqueStrings(
    segments
      .filter(
        (segment): segment is Extract<PromptInputSegment, { type: "source" }> =>
          segment.type === "source",
      )
      .map((segment) => segment.sourceId),
  );

const createSourceMentionElement = (source: PromptInputMentionSource) => {
  const element = document.createElement("span");
  element.contentEditable = "false";
  element.dataset.sourceMentionId = source.id;
  element.dataset.sourceMentionTitle = source.title;
  if (source.meta) {
    element.dataset.sourceMentionMeta = source.meta;
  }
  element.className =
    "mx-0.5 inline max-w-full select-none align-baseline font-medium text-primary underline decoration-primary/35 underline-offset-2";
  element.title = getSourceMentionLabel(source.title);
  element.textContent = getSourceMentionLabel(source.title);
  return element;
};

export function PromptCommandIcon({
  className,
  fallbackIconName,
  icon,
  iconName,
  iconSrc,
  iconTone = "mono",
}: {
  className: string;
  fallbackIconName?: string;
  icon?: ReactNode;
  iconName?: string;
  iconSrc?: string;
  iconTone?: PromptInputCommandIconTone;
}) {
  return (
    <GlobalIcon
      className={className}
      fallbackIconName={fallbackIconName}
      icon={icon}
      iconName={iconName}
      iconSrc={iconSrc}
      iconTone={iconTone}
    />
  );
}

const createSlashCommandElement = (command: PromptInputRenderedCommand) => {
  const element = document.createElement("span");
  element.contentEditable = "false";
  const kind = command.kind ?? "skill";
  const value = normalizeCommandValue(command.value);
  const marker = createCommandMarker({
    kind,
    label: command.label,
    value,
  });
  element.dataset.slashCommandKind = kind;
  element.dataset.slashCommandMarker = marker;
  element.dataset.slashCommandValue = value;
  if (command.iconName) {
    element.dataset.iconName = command.iconName;
    element.dataset.slashCommandIconName = command.iconName;
  }
  if (command.iconTone) {
    element.dataset.iconTone = command.iconTone;
    element.dataset.slashCommandIconTone = command.iconTone;
  }
  if (command.iconSrc) {
    element.dataset.iconSrc = command.iconSrc;
    element.dataset.slashCommandIconSrc = command.iconSrc;
  }
  if (command.label) {
    element.dataset.slashCommandLabel = command.label;
  }
  element.className =
    "mx-0.5 inline-flex h-5 max-w-[240px] select-none items-center gap-1 overflow-hidden truncate whitespace-nowrap align-middle text-sm font-semibold leading-5 text-blue-600 dark:text-blue-400";
  element.title = value;
  const icon = createGlobalIconElement({
    className:
      "inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-muted-foreground",
    fallbackIconName:
      kind === "tool"
        ? DEFAULT_GLOBAL_TOOL_ICON_NAME
        : DEFAULT_GLOBAL_SKILL_ICON_NAME,
    iconName: command.iconName,
    iconSrc: command.iconSrc,
    iconTone: command.iconTone,
  });
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = command.label ?? command.value;
  element.append(icon, label);
  return element;
};

const createSlashCommandElementFromSegment = (
  segment: Extract<PromptInputSegment, { type: "command" }>,
) =>
  createSlashCommandElement({
    iconName: segment.command.iconName,
    iconSrc: segment.command.iconSrc,
    iconTone: segment.command.iconTone,
    id: `initial:${segment.command.value}`,
    kind: segment.command.kind,
    label: segment.command.label,
    value: segment.command.value,
  });

const appendPromptSegmentNode = (
  fragment: DocumentFragment | HTMLElement,
  segment: PromptInputSegment,
) => {
  if (segment.type === "text") {
    fragment.append(document.createTextNode(segment.text));
    return;
  }
  if (segment.type === "command") {
    fragment.append(createSlashCommandElementFromSegment(segment));
    return;
  }
  fragment.append(
    createSourceMentionElement({
      id: segment.sourceId,
      meta: segment.meta,
      title: segment.title,
      type: segment.type,
    }),
  );
};

function SourceMentionIcon({ source }: { source: PromptInputMentionSource }) {
  const type = source.type?.toLowerCase() ?? "";
  if (type.includes("directory") || type.includes("folder")) {
    return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function SlashCommandIcon({ command }: { command: PromptInputSlashCommand }) {
  const toolIconClassName = "size-4 shrink-0 text-blue-600 dark:text-blue-400";
  return (
    <PromptCommandIcon
      className={
        command.iconName || command.iconSrc || command.icon
          ? "size-4 shrink-0 text-muted-foreground"
          : toolIconClassName
      }
      fallbackIconName={
        command.kind === "tool"
          ? DEFAULT_GLOBAL_TOOL_ICON_NAME
          : DEFAULT_GLOBAL_SKILL_ICON_NAME
      }
      icon={command.icon}
      iconName={command.iconName}
      iconSrc={command.iconSrc}
      iconTone={command.iconTone}
    />
  );
}

function SlashCommandText({ command }: { command: PromptInputSlashCommand }) {
  const label = command.label ?? command.value;
  const description = command.description ?? command.group;
  const content = (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium leading-5">{label}</div>
      {description ? (
        <div className="truncate text-xs leading-4 text-muted-foreground">
          {description}
        </div>
      ) : null}
    </div>
  );

  if (!description) {
    return content;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent align="start" side="right">
        <div className="space-y-1 text-left">
          <div className="font-medium">{label}</div>
          <div>{description}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Provider Context & Types
// ============================================================================

export interface AttachmentsContext {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

export interface TextInputContext {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
}

export type PromptInputFormState = {
  canSubmit: boolean;
  setTextInput: (value: string) => void;
};

export interface PromptInputControllerProps {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (
    ref: RefObject<HTMLInputElement | null>,
    open: () => void,
  ) => void;
}

const PromptInputController = createContext<PromptInputControllerProps | null>(
  null,
);
const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(
  null,
);
const PromptInputFormStateContext = createContext<PromptInputFormState | null>(
  null,
);

export const usePromptInputController = () => {
  const ctx = useContext(PromptInputController);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use usePromptInputController().",
    );
  }
  return ctx;
};

// Optional variants (do NOT throw). Useful for dual-mode components.
const useOptionalPromptInputController = () =>
  useContext(PromptInputController);

export const usePromptInputFormState = () =>
  useContext(PromptInputFormStateContext) ?? {
    canSubmit: false,
    setTextInput: () => undefined,
  };

export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use useProviderAttachments().",
    );
  }
  return ctx;
};

const useOptionalProviderAttachments = () =>
  useContext(ProviderAttachmentsContext);

type PromptInputInitialAttachment = FileUIPart & { id?: string };

const normalizeInitialAttachmentFiles = (
  files: PromptInputInitialAttachment[] | undefined,
) =>
  (files ?? []).map((file) => ({
    ...file,
    id: file.id ?? nanoid(),
  }));

export type PromptInputProviderProps = PropsWithChildren<{
  initialAttachments?: PromptInputInitialAttachment[];
  initialInput?: string;
}>;

/**
 * Optional global provider that lifts PromptInput state outside of PromptInput.
 * If you don't use it, PromptInput stays fully self-managed.
 */
export const PromptInputProvider = ({
  initialAttachments,
  initialInput: initialTextInput = "",
  children,
}: PromptInputProviderProps) => {
  // ----- textInput state
  const [textInput, setTextInput] = useState(initialTextInput);
  const clearInput = useCallback(() => setTextInput(""), []);

  // ----- attachments state (global when wrapped)
  const [attachmentFiles, setAttachmentFiles] = useState<
    (FileUIPart & { id: string })[]
  >(() => normalizeInitialAttachmentFiles(initialAttachments));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // oxlint-disable-next-line eslint(no-empty-function)
  const openRef = useRef<() => void>(() => {});

  const add = useCallback((files: File[] | FileList) => {
    const incoming = [...files];
    if (incoming.length === 0) {
      return;
    }

    setAttachmentFiles((prev) => [
      ...prev,
      ...incoming.map((file) => ({
        filename: file.name,
        id: nanoid(),
        mediaType: file.type,
        type: "file" as const,
        url: URL.createObjectURL(file),
      })),
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    setAttachmentFiles((prev) => {
      const found = prev.find((f) => f.id === id);
      if (found?.url) {
        URL.revokeObjectURL(found.url);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachmentFiles((prev) => {
      for (const f of prev) {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
      }
      return [];
    });
  }, []);

  // Keep a ref to attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef(attachmentFiles);

  useEffect(() => {
    attachmentsRef.current = attachmentFiles;
  }, [attachmentFiles]);

  // Cleanup blob URLs on unmount to prevent memory leaks
  useEffect(
    () => () => {
      for (const f of attachmentsRef.current) {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
      }
    },
    [],
  );

  const openFileDialog = useCallback(() => {
    openRef.current?.();
  }, []);

  const attachments = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear,
      fileInputRef,
      files: attachmentFiles,
      openFileDialog,
      remove,
    }),
    [attachmentFiles, add, remove, clear, openFileDialog],
  );

  const __registerFileInput = useCallback(
    (ref: RefObject<HTMLInputElement | null>, open: () => void) => {
      fileInputRef.current = ref.current;
      openRef.current = open;
    },
    [],
  );

  const controller = useMemo<PromptInputControllerProps>(
    () => ({
      __registerFileInput,
      attachments,
      textInput: {
        clear: clearInput,
        setInput: setTextInput,
        value: textInput,
      },
    }),
    [textInput, clearInput, attachments, __registerFileInput],
  );

  return (
    <PromptInputController.Provider value={controller}>
      <ProviderAttachmentsContext.Provider value={attachments}>
        {children}
      </ProviderAttachmentsContext.Provider>
    </PromptInputController.Provider>
  );
};

// ============================================================================
// Component Context & Hooks
// ============================================================================

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
  // Prefer local context (inside PromptInput) as it has validation, fall back to provider
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    );
  }
  return context;
};

// ============================================================================
// Referenced Sources (Local to PromptInput)
// ============================================================================

export interface ReferencedSourcesContext {
  sources: (SourceDocumentUIPart & { id: string })[];
  add: (sources: SourceDocumentUIPart[] | SourceDocumentUIPart) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const LocalReferencedSourcesContext =
  createContext<ReferencedSourcesContext | null>(null);

export const usePromptInputReferencedSources = () => {
  const ctx = useContext(LocalReferencedSourcesContext);
  if (!ctx) {
    throw new Error(
      "usePromptInputReferencedSources must be used within a LocalReferencedSourcesContext.Provider",
    );
  }
  return ctx;
};

export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = "Add photos or files",
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    (e: Event) => {
      e.preventDefault();
      attachments.openFileDialog();
    },
    [attachments],
  );

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <ImageIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

export type PromptInputActionAddScreenshotProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddScreenshot = ({
  label = "Take screenshot",
  onSelect,
  ...props
}: PromptInputActionAddScreenshotProps) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    async (event: Event) => {
      onSelect?.(event);
      if (event.defaultPrevented) {
        return;
      }

      try {
        const screenshot = await captureScreenshot();
        if (screenshot) {
          attachments.add([screenshot]);
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "AbortError")
        ) {
          return;
        }
        throw error;
      }
    },
    [onSelect, attachments],
  );

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <Monitor className="mr-2 size-4" />
      {label}
    </DropdownMenuItem>
  );
};

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
  mentionedSourceIds?: string[];
  segments?: PromptInputSegment[];
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit" | "onError"
> & {
  // e.g., "image/*" or leave undefined for any
  accept?: string;
  multiple?: boolean;
  // When true, accepts drops anywhere on document. Default false (opt-in).
  globalDrop?: boolean;
  // Render a hidden input with given name and keep it in sync for native form posts. Default false.
  syncHiddenInput?: boolean;
  submitDisabled?: boolean;
  // Minimal constraints
  maxFiles?: number;
  // bytes
  maxFileSize?: number;
  onError?: (err: {
    code: "max_files" | "max_file_size" | "accept";
    message: string;
  }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  submitDisabled,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  // Try to use a provider controller if present
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  // Refs
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // ----- Local attachments (only used when no provider)
  const [items, setItems] = useState<(FileUIPart & { id: string })[]>([]);
  const [localTextInput, setLocalTextInput] = useState("");
  const files = usingProvider ? controller.attachments.files : items;
  const textInput = usingProvider ? controller.textInput.value : localTextInput;

  // ----- Local referenced sources (always local to PromptInput)
  const [referencedSources, setReferencedSources] = useState<
    (SourceDocumentUIPart & { id: string })[]
  >([]);

  // Keep a ref to files for cleanup on unmount (avoids stale closure)
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") {
        return true;
      }

      const patterns = accept
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      return patterns.some((pattern) => {
        if (pattern.endsWith("/*")) {
          // e.g: image/* -> image/
          const prefix = pattern.slice(0, -1);
          return f.type.startsWith(prefix);
        }
        return f.type === pattern;
      });
    },
    [accept],
  );

  const addLocal = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "No files match the accepted types.",
        });
        return;
      }
      const withinSize = (f: File) =>
        maxFileSize ? f.size <= maxFileSize : true;
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "All files exceed the maximum size.",
        });
        return;
      }

      setItems((prev) => {
        const capacity =
          typeof maxFiles === "number"
            ? Math.max(0, maxFiles - prev.length)
            : undefined;
        const capped =
          typeof capacity === "number" ? sized.slice(0, capacity) : sized;
        if (typeof capacity === "number" && sized.length > capacity) {
          onError?.({
            code: "max_files",
            message: "Too many files. Some were not added.",
          });
        }
        const next: (FileUIPart & { id: string })[] = [];
        for (const file of capped) {
          next.push({
            filename: file.name,
            id: nanoid(),
            mediaType: file.type,
            type: "file",
            url: URL.createObjectURL(file),
          });
        }
        return [...prev, ...next];
      });
    },
    [matchesAccept, maxFiles, maxFileSize, onError],
  );

  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) {
          URL.revokeObjectURL(found.url);
        }
        return prev.filter((file) => file.id !== id);
      }),
    [],
  );

  // Wrapper that validates files before calling provider's add
  const addWithProviderValidation = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "No files match the accepted types.",
        });
        return;
      }
      const withinSize = (f: File) =>
        maxFileSize ? f.size <= maxFileSize : true;
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "All files exceed the maximum size.",
        });
        return;
      }

      const currentCount = files.length;
      const capacity =
        typeof maxFiles === "number"
          ? Math.max(0, maxFiles - currentCount)
          : undefined;
      const capped =
        typeof capacity === "number" ? sized.slice(0, capacity) : sized;
      if (typeof capacity === "number" && sized.length > capacity) {
        onError?.({
          code: "max_files",
          message: "Too many files. Some were not added.",
        });
      }

      if (capped.length > 0) {
        controller?.attachments.add(capped);
      }
    },
    [matchesAccept, maxFileSize, maxFiles, onError, files.length, controller],
  );

  const clearAttachments = useCallback(
    () =>
      usingProvider
        ? controller?.attachments.clear()
        : setItems((prev) => {
            for (const file of prev) {
              if (file.url) {
                URL.revokeObjectURL(file.url);
              }
            }
            return [];
          }),
    [usingProvider, controller],
  );

  const clearReferencedSources = useCallback(
    () => setReferencedSources([]),
    [],
  );

  const add = usingProvider ? addWithProviderValidation : addLocal;
  const remove = usingProvider ? controller.attachments.remove : removeLocal;
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  const clear = useCallback(() => {
    clearAttachments();
    clearReferencedSources();
  }, [clearAttachments, clearReferencedSources]);

  // Let provider know about our hidden file input so external menus can call openFileDialog()
  useEffect(() => {
    if (!usingProvider) {
      return;
    }
    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  // Note: File input cannot be programmatically set for security reasons
  // The syncHiddenInput prop is no longer functional
  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = "";
    }
  }, [files, syncHiddenInput]);

  // Attach drop handlers on nearest form and document (opt-in)
  useEffect(() => {
    const form = formRef.current;
    if (!form) {
      return;
    }
    if (globalDrop) {
      // when global drop is on, let the document-level handler own drops
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(() => {
    if (!globalDrop) {
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) {
            URL.revokeObjectURL(f.url);
          }
        }
      }
    },
    [usingProvider],
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) {
        add(event.currentTarget.files);
      }
      // Reset input value to allow selecting files that were previously removed
      event.currentTarget.value = "";
    },
    [add],
  );

  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear: clearAttachments,
      fileInputRef: inputRef,
      files: files.map((item) => ({ ...item, id: item.id })),
      openFileDialog,
      remove,
    }),
    [files, add, remove, clearAttachments, openFileDialog],
  );
  const formState = useMemo<PromptInputFormState>(
    () => ({
      canSubmit: hasPromptSubmitText(textInput) || files.length > 0,
      setTextInput: usingProvider
        ? controller.textInput.setInput
        : setLocalTextInput,
    }),
    [usingProvider, controller, textInput, files.length],
  );

  const refsCtx = useMemo<ReferencedSourcesContext>(
    () => ({
      add: (incoming: SourceDocumentUIPart[] | SourceDocumentUIPart) => {
        const array = Array.isArray(incoming) ? incoming : [incoming];
        setReferencedSources((prev) => [
          ...prev,
          ...array.map((s) => ({ ...s, id: nanoid() })),
        ]);
      },
      clear: clearReferencedSources,
      remove: (id: string) => {
        setReferencedSources((prev) => prev.filter((s) => s.id !== id));
      },
      sources: referencedSources,
    }),
    [referencedSources, clearReferencedSources],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault();

      if (submitDisabled) {
        return;
      }

      const form = event.currentTarget;
      const formData = new FormData(form);
      const text = usingProvider
        ? controller.textInput.value
        : (formData.get("message") as string) || "";
      const mentionedSourceIds = [
        ...new Set(
          formData
            .getAll("mentionedSourceIds")
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      const editor = form.querySelector(
        '[data-prompt-input-editor="true"]',
      ) as HTMLElement | null;
      const segments = editor ? readSegmentsFromElement(editor) : undefined;

      // Reset form immediately after capturing text to avoid race condition
      // where user input during async blob conversion would be lost
      if (!usingProvider) {
        form.reset();
      }

      try {
        // Convert local blobs and editable hosted images to data URLs.
        const convertedFiles: FileUIPart[] = await Promise.all(
          files.map(async ({ id: _id, ...item }) => {
            if (shouldConvertFileUrlToDataUrl(item)) {
              const dataUrl = await convertFileUrlToDataUrl(item.url);
              if (!dataUrl) {
                throw new Error("Unable to read attachment.");
              }
              return {
                ...item,
                url: dataUrl,
              };
            }
            return item;
          }),
        );

        if (!hasPromptSubmitText(text) && convertedFiles.length === 0) {
          return;
        }

        const result = onSubmit(
          { files: convertedFiles, mentionedSourceIds, segments, text },
          event,
        );

        // Handle both sync and async onSubmit
        if (result instanceof Promise) {
          try {
            await result;
            clear();
            if (usingProvider) {
              controller.textInput.clear();
            }
          } catch {
            // Don't clear on error - user may want to retry
          }
        } else {
          // Sync function completed without throwing, clear inputs
          clear();
          if (usingProvider) {
            controller.textInput.clear();
          }
        }
      } catch {
        // Don't clear on error - user may want to retry
      }
    },
    [usingProvider, controller, files, onSubmit, clear, submitDisabled],
  );

  // Render with or without local provider
  const inner = (
    <>
      <input
        accept={accept}
        aria-label="Upload files"
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title="Upload files"
        type="file"
      />
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        ref={formRef}
        {...props}
      >
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
    </>
  );

  const withReferencedSources = (
    <LocalReferencedSourcesContext.Provider value={refsCtx}>
      {inner}
    </LocalReferencedSourcesContext.Provider>
  );

  // Always provide LocalAttachmentsContext so children get validated add function
  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      <PromptInputFormStateContext.Provider value={formState}>
        {withReferencedSources}
      </PromptInputFormStateContext.Provider>
    </LocalAttachmentsContext.Provider>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<
  typeof InputGroupTextarea
>;

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const formState = usePromptInputFormState();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      // Call the external onKeyDown handler first
      onKeyDown?.(e);

      // If the external handler prevented default, don't run internal logic
      if (e.defaultPrevented) {
        return;
      }

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();

        // Check if the submit button is unavailable before submitting
        const { form } = e.currentTarget;
        const submitButton = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        if (
          submitButton?.disabled ||
          submitButton?.getAttribute("aria-disabled") === "true"
        ) {
          return;
        }

        form?.requestSubmit();
      }

      // Remove last attachment when Backspace is pressed and textarea is empty
      if (
        e.key === "Backspace" &&
        e.currentTarget.value === "" &&
        attachments.files.length > 0
      ) {
        e.preventDefault();
        const lastAttachment = attachments.files.at(-1);
        if (lastAttachment) {
          attachments.remove(lastAttachment.id);
        }
      }
    },
    [onKeyDown, isComposing, attachments],
  );

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      const items = event.clipboardData?.items;

      if (!items) {
        return;
      }

      const files: File[] = [];

      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length > 0) {
        event.preventDefault();
        attachments.add(files);
      }
    },
    [attachments],
  );

  const handleCompositionEnd = useCallback(() => setIsComposing(false), []);
  const handleCompositionStart = useCallback(() => setIsComposing(true), []);

  const controlledProps = controller
    ? {
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
        },
        value: controller.textInput.value,
      }
    : {
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          formState.setTextInput(e.currentTarget.value);
          onChange?.(e);
        },
      };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
      {...controlledProps}
    />
  );
};

export type PromptInputMentionEditorProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange" | "placeholder"
> & {
  disabled?: boolean;
  initialValue?: string;
  initialSegments?: PromptInputSegment[];
  name?: string;
  onValueChange?: (input: {
    mentionedSourceIds: string[];
    segments: PromptInputSegment[];
    text: string;
  }) => void;
  onSlashCommandSelect?: (command: PromptInputSlashCommand) => void;
  placeholder?: string;
  slashCommands?: PromptInputSlashCommand[];
  sourceLoader?: PromptInputMentionSourceLoader;
  sources: PromptInputMentionSource[];
};

export const PromptInputMentionEditor = ({
  className,
  disabled,
  initialValue = "",
  initialSegments,
  name = "message",
  onKeyDown,
  onPaste,
  onSlashCommandSelect,
  onValueChange,
  placeholder = "What would you like to know?",
  slashCommands = [],
  sourceLoader,
  sources,
  ...props
}: PromptInputMentionEditorProps) => {
  const controller = useOptionalPromptInputController();
  const formState = usePromptInputFormState();
  const attachments = usePromptInputAttachments();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [segments, setSegments] = useState<PromptInputSegment[]>(() =>
    initialSegments && initialSegments.length > 0
      ? initialSegments
      : initialValue
        ? parsePromptInputMarkers(initialValue)
        : [],
  );
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartOffset, setMentionStartOffset] = useState<number | null>(
    null,
  );
  const [isMentionOpen, setIsMentionOpen] = useState(false);
  const [mentionResults, setMentionResults] = useState<
    PromptInputMentionSource[]
  >([]);
  const [mentionNextCursor, setMentionNextCursor] = useState<string | null>(
    null,
  );
  const [mentionHighlightedIndex, setMentionHighlightedIndex] = useState(0);
  const [isMentionLoading, setIsMentionLoading] = useState(false);
  const [isMentionLoadingMore, setIsMentionLoadingMore] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashStartOffset, setSlashStartOffset] = useState<number | null>(null);
  const [isSlashOpen, setIsSlashOpen] = useState(false);
  const [slashHighlightedIndex, setSlashHighlightedIndex] = useState(0);
  const [slashCommandPath, setSlashCommandPath] = useState<
    PromptInputSlashCommand[]
  >([]);
  const mentionListRef = useRef<HTMLDivElement | null>(null);
  const mentionItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const slashListRef = useRef<HTMLDivElement | null>(null);
  const slashItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const mentionRequestSeqRef = useRef(0);

  const text = useMemo(() => serializePromptSegments(segments), [segments]);
  const mentionedSourceIds = useMemo(
    () => mentionedSourceIdsFromSegments(segments),
    [segments],
  );

  const localFilteredSources = useMemo(() => {
    const query = mentionQuery.trim().toLowerCase();
    const candidates = sources.filter(
      (source) => source.title.trim().length > 0,
    );
    if (!query) {
      return candidates.slice(0, SOURCE_MENTION_PAGE_SIZE);
    }

    return candidates
      .filter((source) => {
        const haystack =
          `${source.title} ${source.meta ?? ""} ${source.type ?? ""}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, SOURCE_MENTION_PAGE_SIZE);
  }, [mentionQuery, sources]);
  const filteredSources = sourceLoader ? mentionResults : localFilteredSources;
  const hasMentionMore = sourceLoader ? Boolean(mentionNextCursor) : false;
  const isMentionPopoverOpen =
    isMentionOpen &&
    (Boolean(sourceLoader) ||
      filteredSources.length > 0 ||
      mentionQuery.trim().length > 0);
  const activeSlashParent = slashCommandPath.at(-1);
  const activeSlashCommands = activeSlashParent?.children ?? slashCommands;
  const filteredSlashCommands = useMemo(() => {
    return filterSlashCommands(activeSlashCommands, slashQuery);
  }, [activeSlashCommands, slashQuery]);
  const isSlashPopoverOpen = isSlashOpen;

  const publishSegments = useCallback(
    (nextSegments: PromptInputSegment[]) => {
      setSegments(nextSegments);
      const nextText = serializePromptSegments(nextSegments);
      const nextMentionedSourceIds =
        mentionedSourceIdsFromSegments(nextSegments);
      formState.setTextInput(nextText);
      onValueChange?.({
        mentionedSourceIds: nextMentionedSourceIds,
        segments: nextSegments,
        text: nextText,
      });
    },
    [formState, onValueChange],
  );

  const syncFromDom = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    publishSegments(readSegmentsFromElement(editor));
  }, [publishSegments]);

  const updateMentionState = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || isComposing) {
      return;
    }

    const caretOffset = getCaretTextOffset(editor);
    const content = getPromptDisplayText(editor);
    const beforeCaret = content.slice(0, caretOffset);
    const match = SOURCE_MENTION_TRIGGER_PATTERN.exec(beforeCaret);
    if (!match) {
      setIsMentionOpen(false);
      setMentionQuery("");
      setMentionStartOffset(null);
      return;
    }

    const query = match[1] ?? "";
    setMentionStartOffset(caretOffset - query.length - 1);
    setMentionQuery(query);
    setIsMentionOpen(true);
  }, [isComposing]);

  const updateSlashState = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || isComposing) {
      return;
    }

    const caretOffset = getCaretTextOffset(editor);
    const content = getPromptDisplayText(editor);
    const beforeCaret = content.slice(0, caretOffset);
    const match = SLASH_COMMAND_TRIGGER_PATTERN.exec(beforeCaret);
    if (!match) {
      setIsSlashOpen(false);
      setSlashQuery("");
      setSlashStartOffset(null);
      setSlashCommandPath([]);
      return;
    }

    const query = match[1] ?? "";
    const triggerText = match[0] ?? "";
    const slashIndexInTrigger = triggerText.lastIndexOf("/");
    setSlashStartOffset(
      caretOffset - triggerText.length + Math.max(0, slashIndexInTrigger),
    );
    setSlashQuery(query);
    setIsSlashOpen(true);
    setIsMentionOpen(false);
  }, [isComposing]);

  const syncAndUpdateMention = useCallback(() => {
    syncFromDom();
    window.requestAnimationFrame(() => {
      updateSlashState();
      updateMentionState();
    });
  }, [syncFromDom, updateMentionState, updateSlashState]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.childNodes.length > 0) {
      return;
    }

    const nextSegments =
      initialSegments && initialSegments.length > 0
        ? initialSegments
        : initialValue
          ? parsePromptInputMarkers(initialValue)
          : [];
    if (nextSegments.length === 0) {
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const segment of nextSegments) {
      appendPromptSegmentNode(fragment, segment);
    }
    editor.append(fragment);
    publishSegments(nextSegments);
  }, [initialSegments, initialValue, publishSegments]);

  const closeMention = useCallback(() => {
    setIsMentionOpen(false);
    setMentionQuery("");
    setMentionStartOffset(null);
    setMentionHighlightedIndex(0);
  }, []);

  const closeSlash = useCallback(() => {
    setIsSlashOpen(false);
    setSlashQuery("");
    setSlashStartOffset(null);
    setSlashHighlightedIndex(0);
    setSlashCommandPath([]);
  }, []);

  const openSlashSubmenu = useCallback((command: PromptInputSlashCommand) => {
    if (!slashCommandHasChildren(command)) {
      return false;
    }
    setSlashCommandPath((current) => [...current, command]);
    setSlashHighlightedIndex(0);
    slashItemRefs.current.clear();
    return true;
  }, []);

  const goBackSlashSubmenu = useCallback(() => {
    setSlashCommandPath((current) => current.slice(0, -1));
    setSlashHighlightedIndex(0);
    slashItemRefs.current.clear();
  }, []);

  useEffect(() => {
    if (!isMentionOpen || !sourceLoader) {
      return;
    }

    const requestSeq = mentionRequestSeqRef.current + 1;
    mentionRequestSeqRef.current = requestSeq;
    setIsMentionLoading(true);
    setIsMentionLoadingMore(false);
    setMentionHighlightedIndex(0);

    sourceLoader({
      limit: SOURCE_MENTION_PAGE_SIZE,
      query: mentionQuery.trim(),
    })
      .then((page) => {
        if (mentionRequestSeqRef.current !== requestSeq) {
          return;
        }
        setMentionResults(page.items);
        setMentionNextCursor(page.nextCursor ?? null);
      })
      .catch(() => {
        if (mentionRequestSeqRef.current !== requestSeq) {
          return;
        }
        setMentionResults([]);
        setMentionNextCursor(null);
      })
      .finally(() => {
        if (mentionRequestSeqRef.current === requestSeq) {
          setIsMentionLoading(false);
        }
      });
  }, [isMentionOpen, mentionQuery, sourceLoader]);

  const loadMoreMentionSources = useCallback(() => {
    if (
      !sourceLoader ||
      !mentionNextCursor ||
      isMentionLoading ||
      isMentionLoadingMore
    ) {
      return;
    }

    setIsMentionLoadingMore(true);
    sourceLoader({
      cursor: mentionNextCursor,
      limit: SOURCE_MENTION_PAGE_SIZE,
      query: mentionQuery.trim(),
    })
      .then((page) => {
        setMentionResults((current) => {
          const seen = new Set(current.map((source) => source.id));
          const next = page.items.filter((source) => !seen.has(source.id));
          return [...current, ...next];
        });
        setMentionNextCursor(page.nextCursor ?? null);
      })
      .catch(() => {
        setMentionNextCursor(null);
      })
      .finally(() => {
        setIsMentionLoadingMore(false);
      });
  }, [
    isMentionLoading,
    isMentionLoadingMore,
    mentionNextCursor,
    mentionQuery,
    sourceLoader,
  ]);

  useEffect(() => {
    if (!isMentionOpen) {
      return;
    }

    setMentionHighlightedIndex((index) => {
      if (filteredSources.length === 0) {
        return 0;
      }
      return Math.min(index, filteredSources.length - 1);
    });
  }, [filteredSources.length, isMentionOpen]);

  useEffect(() => {
    if (!isSlashOpen) {
      return;
    }

    setSlashHighlightedIndex((index) => {
      if (filteredSlashCommands.length === 0) {
        return 0;
      }
      return Math.min(index, filteredSlashCommands.length - 1);
    });
  }, [filteredSlashCommands.length, isSlashOpen]);

  useEffect(() => {
    if (!isMentionOpen) {
      return;
    }

    const item = mentionItemRefs.current.get(mentionHighlightedIndex);
    const container = mentionListRef.current;
    if (!item || !container) {
      return;
    }

    const itemRect = item.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const padding = 6;
    if (itemRect.top < containerRect.top + padding) {
      container.scrollTop -= containerRect.top + padding - itemRect.top;
      return;
    }
    if (itemRect.bottom > containerRect.bottom - padding) {
      container.scrollTop += itemRect.bottom - (containerRect.bottom - padding);
    }
  }, [isMentionOpen, mentionHighlightedIndex]);

  useEffect(() => {
    if (!isSlashOpen) {
      return;
    }

    const item = slashItemRefs.current.get(slashHighlightedIndex);
    const container = slashListRef.current;
    if (!item || !container) {
      return;
    }

    const itemRect = item.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const padding = 6;
    if (itemRect.top < containerRect.top + padding) {
      container.scrollTop -= containerRect.top + padding - itemRect.top;
      return;
    }
    if (itemRect.bottom > containerRect.bottom - padding) {
      container.scrollTop += itemRect.bottom - (containerRect.bottom - padding);
    }
  }, [isSlashOpen, slashHighlightedIndex]);

  useEffect(() => {
    if (!controller || controller.textInput.value !== "" || text === "") {
      return;
    }

    const editor = editorRef.current;
    if (editor) {
      editor.textContent = "";
    }
    setSegments([]);
    closeMention();
    closeSlash();
  }, [closeMention, closeSlash, controller, text]);

  useEffect(() => {
    const editor = editorRef.current;
    const form = editor?.closest("form");
    if (!editor || !form) {
      return;
    }

    const handleReset = () => {
      editor.textContent = "";
      setSegments([]);
      closeMention();
      closeSlash();
    };

    form.addEventListener("reset", handleReset);
    return () => {
      form.removeEventListener("reset", handleReset);
    };
  }, [closeMention, closeSlash]);

  useEffect(() => {
    if (!isMentionOpen || sourceLoader) {
      return;
    }

    if (!isMentionLoading && filteredSources.length === 0) {
      closeMention();
    }
  }, [
    closeMention,
    filteredSources.length,
    isMentionLoading,
    isMentionOpen,
    sourceLoader,
  ]);

  const selectSource = useCallback(
    (source: PromptInputMentionSource) => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      editor.focus();
      const selection = window.getSelection();
      const caretOffset =
        selection &&
        selection.rangeCount > 0 &&
        editor.contains(selection.getRangeAt(0).endContainer)
          ? getCaretTextOffset(editor)
          : (editor.textContent?.length ?? 0);
      const startOffset =
        mentionStartOffset ??
        Math.max(0, caretOffset - mentionQuery.length - 1);
      const fragment = document.createDocumentFragment();
      fragment.append(createSourceMentionElement(source));
      fragment.append(document.createTextNode(" "));
      replaceTextRange(editor, startOffset, caretOffset, fragment);
      closeMention();
      const nextOffset =
        startOffset + getSourceMentionLabel(source.title).length + 1;
      setCaretTextOffset(editor, nextOffset);
      syncFromDom();
    },
    [closeMention, mentionQuery.length, mentionStartOffset, syncFromDom],
  );

  const selectSlashCommand = useCallback(
    (command: PromptInputSlashCommand) => {
      if (command.disabled) {
        return;
      }
      if (openSlashSubmenu(command)) {
        editorRef.current?.focus();
        return;
      }
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      editor.focus();
      const selection = window.getSelection();
      const caretOffset =
        selection &&
        selection.rangeCount > 0 &&
        editor.contains(selection.getRangeAt(0).endContainer)
          ? getCaretTextOffset(editor)
          : (editor.textContent?.length ?? 0);
      const startOffset =
        slashStartOffset ?? Math.max(0, caretOffset - slashQuery.length - 1);
      const fragment = document.createDocumentFragment();
      const commandElement = createSlashCommandElement(command);
      fragment.append(commandElement);
      fragment.append(document.createTextNode(" "));
      replaceTextRange(editor, startOffset, caretOffset, fragment);
      if (command.kind === "skill" && command.value.includes(":")) {
        removeSlashCommands(
          editor,
          (element) =>
            element.dataset.slashCommandValue !== command.value &&
            element.dataset.slashCommandKind === "skill" &&
            (element.dataset.slashCommandValue ?? "").includes(":"),
        );
      }
      closeSlash();
      setCaretAfterNode(commandElement.nextSibling ?? commandElement);
      syncFromDom();
      onSlashCommandSelect?.(command);
    },
    [
      closeSlash,
      onSlashCommandSelect,
      openSlashSubmenu,
      slashQuery.length,
      slashStartOffset,
      syncFromDom,
    ],
  );

  const handleInput = useCallback(() => {
    syncAndUpdateMention();
  }, [syncAndUpdateMention]);

  const handleClick: MouseEventHandler<HTMLDivElement> = useCallback(() => {
    updateSlashState();
    updateMentionState();
  }, [updateMentionState, updateSlashState]);

  const handleCompositionStart = useCallback(() => setIsComposing(true), []);
  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    window.requestAnimationFrame(syncAndUpdateMention);
  }, [syncAndUpdateMention]);

  const handlePaste: ClipboardEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      onPaste?.(event);
      if (event.defaultPrevented) {
        return;
      }

      const files: File[] = [];
      for (const item of event.clipboardData?.items ?? []) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        attachments.add(files);
        return;
      }

      const plainText = event.clipboardData?.getData("text/plain");
      if (plainText) {
        event.preventDefault();
        insertTextAtCaret(event.currentTarget, plainText);
        syncAndUpdateMention();
      }
    },
    [attachments, onPaste, syncAndUpdateMention],
  );

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) {
        return;
      }

      if (isSlashOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          if (slashCommandPath.length > 0) {
            goBackSlashSubmenu();
            return;
          }
          closeSlash();
          return;
        }
        if (e.key === "ArrowLeft" && slashCommandPath.length > 0) {
          e.preventDefault();
          goBackSlashSubmenu();
          return;
        }
        if (e.key === "ArrowRight") {
          const command =
            filteredSlashCommands[slashHighlightedIndex] ??
            filteredSlashCommands[0];
          if (command && slashCommandHasChildren(command)) {
            e.preventDefault();
            openSlashSubmenu(command);
            return;
          }
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (filteredSlashCommands.length > 0) {
            setSlashHighlightedIndex((index) =>
              index < filteredSlashCommands.length - 1 ? index + 1 : 0,
            );
          }
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (filteredSlashCommands.length > 0) {
            setSlashHighlightedIndex((index) =>
              index > 0 ? index - 1 : filteredSlashCommands.length - 1,
            );
          }
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          const command =
            filteredSlashCommands[slashHighlightedIndex] ??
            filteredSlashCommands[0];
          if (command) {
            e.preventDefault();
            selectSlashCommand(command);
            return;
          }
        }
      }

      if (isMentionOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeMention();
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (filteredSources.length > 0) {
            setMentionHighlightedIndex((index) =>
              index < filteredSources.length - 1 ? index + 1 : 0,
            );
          }
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (filteredSources.length > 0) {
            setMentionHighlightedIndex((index) =>
              index > 0 ? index - 1 : filteredSources.length - 1,
            );
          }
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          const source =
            filteredSources[mentionHighlightedIndex] ?? filteredSources[0];
          if (source) {
            e.preventDefault();
            selectSource(source);
            return;
          }
        }
      }

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();

        const submitButton = e.currentTarget
          .closest("form")
          ?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (
          submitButton?.disabled ||
          submitButton?.getAttribute("aria-disabled") === "true"
        ) {
          return;
        }

        e.currentTarget.closest("form")?.requestSubmit();
        return;
      }

      if (e.key === "Backspace") {
        const editor = editorRef.current;
        if (!editor) {
          return;
        }

        const mention = findSourceMentionBeforeCaret(editor);
        if (mention) {
          e.preventDefault();
          mention.remove();
          syncAndUpdateMention();
          return;
        }

        const selection = window.getSelection();
        if (selection?.rangeCount && selection.isCollapsed) {
          const range = selection.getRangeAt(0);
          if (editor.contains(range.startContainer)) {
            const command =
              range.startContainer.nodeType === Node.TEXT_NODE &&
              range.startOffset === 0
                ? closestSlashCommand(findPreviousNode(range.startContainer))
                : range.startContainer.nodeType !== Node.TEXT_NODE
                  ? closestSlashCommand(
                      range.startContainer.childNodes.item(
                        range.startOffset - 1,
                      ),
                    )
                  : null;
            if (command) {
              e.preventDefault();
              command.remove();
              syncAndUpdateMention();
              return;
            }
          }
        }

        if ((editor.textContent ?? "") === "" && attachments.files.length > 0) {
          e.preventDefault();
          const lastAttachment = attachments.files.at(-1);
          if (lastAttachment) {
            attachments.remove(lastAttachment.id);
          }
        }
      }
    },
    [
      attachments,
      closeMention,
      closeSlash,
      filteredSlashCommands,
      filteredSources,
      goBackSlashSubmenu,
      mentionHighlightedIndex,
      isComposing,
      isMentionOpen,
      isSlashOpen,
      onKeyDown,
      openSlashSubmenu,
      selectSource,
      selectSlashCommand,
      slashCommandPath.length,
      slashHighlightedIndex,
      syncAndUpdateMention,
    ],
  );

  return (
    <div className="relative w-full">
      <input name={name} type="hidden" value={text} />
      {mentionedSourceIds.map((sourceId) => (
        <input
          key={sourceId}
          name="mentionedSourceIds"
          type="hidden"
          value={sourceId}
        />
      ))}
      <div
        aria-disabled={disabled || undefined}
        aria-label={placeholder}
        className={cn(
          "field-sizing-content max-h-48 min-h-16 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-none border-0 bg-transparent px-3 py-2 text-sm shadow-none outline-none ring-0 empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] focus-visible:ring-0",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        contentEditable={!disabled}
        data-placeholder={placeholder}
        data-prompt-input-editor="true"
        data-slot="input-group-control"
        onClick={handleClick}
        onCompositionEnd={handleCompositionEnd}
        onCompositionStart={handleCompositionStart}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        suppressContentEditableWarning
        {...props}
      />
      <Popover open={isMentionPopoverOpen}>
        <PopoverAnchor asChild>
          <span className="pointer-events-none absolute left-3 top-3 size-0" />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-[320px] overflow-hidden rounded-lg border-border/80 bg-popover p-0 shadow-xl"
          onOpenAutoFocus={(event) => event.preventDefault()}
          side="top"
          sideOffset={8}
        >
          <Command
            onKeyDown={(event) => {
              if (
                event.key === "ArrowDown" ||
                event.key === "ArrowUp" ||
                event.key === "Enter"
              ) {
                event.preventDefault();
              }
            }}
            shouldFilter={false}
          >
            <CommandList
              className="max-h-[280px]"
              onScroll={(event) => {
                const target = event.currentTarget;
                const distanceToBottom =
                  target.scrollHeight - target.scrollTop - target.clientHeight;
                if (distanceToBottom < 48) {
                  loadMoreMentionSources();
                }
              }}
              ref={mentionListRef}
            >
              <CommandGroup
                className="px-2 py-1.5"
                heading={isMentionLoading ? "Loading sources" : "Sources"}
              >
                {isMentionLoading && filteredSources.length === 0 ? (
                  <div className="space-y-1 px-1 py-1">
                    {["a", "b", "c", "d"].map((id) => (
                      <div
                        className="flex items-center gap-2 rounded-md px-2 py-2"
                        key={id}
                      >
                        <span className="size-4 rounded bg-muted" />
                        <span className="h-3 flex-1 rounded bg-muted" />
                      </div>
                    ))}
                  </div>
                ) : null}
                {!isMentionLoading && filteredSources.length === 0 ? (
                  <CommandEmpty className="px-3 py-3 text-xs text-muted-foreground">
                    No matching sources
                  </CommandEmpty>
                ) : null}
                {filteredSources.map((source, index) => (
                  <CommandItem
                    className={cn(
                      "min-h-9 cursor-pointer gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted hover:text-foreground data-[highlighted=true]:bg-muted data-[highlighted=true]:text-foreground data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
                      index === mentionHighlightedIndex &&
                        "bg-muted text-foreground",
                    )}
                    data-highlighted={
                      index === mentionHighlightedIndex ? "true" : undefined
                    }
                    key={source.id}
                    onMouseEnter={() => setMentionHighlightedIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onSelect={() => selectSource(source)}
                    ref={(node) => {
                      if (node) {
                        mentionItemRefs.current.set(index, node);
                      } else {
                        mentionItemRefs.current.delete(index);
                      }
                    }}
                    value={source.id}
                  >
                    <SourceMentionIcon source={source} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium leading-5">
                        {source.title}
                      </div>
                      {source.meta ? (
                        <div className="truncate text-xs leading-4 text-muted-foreground">
                          {source.meta}
                        </div>
                      ) : null}
                    </div>
                  </CommandItem>
                ))}
                {isMentionLoadingMore ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                    <Spinner className="size-3" />
                    Loading more
                  </div>
                ) : hasMentionMore ? (
                  <button
                    className="mx-1 my-1 w-[calc(100%-0.5rem)] rounded-md px-2 py-1.5 text-center text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={loadMoreMentionSources}
                    type="button"
                  >
                    Load more
                  </button>
                ) : null}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Popover open={isSlashPopoverOpen}>
        <PopoverAnchor asChild>
          <span className="pointer-events-none absolute left-3 top-3 size-0" />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-[360px] overflow-hidden rounded-lg border-border/80 bg-popover p-0 shadow-xl"
          onOpenAutoFocus={(event) => event.preventDefault()}
          side="top"
          sideOffset={8}
        >
          <Command
            onKeyDown={(event) => {
              if (
                event.key === "ArrowDown" ||
                event.key === "ArrowUp" ||
                event.key === "Enter"
              ) {
                event.preventDefault();
              }
            }}
            shouldFilter={false}
          >
            <CommandList className="max-h-[280px]" ref={slashListRef}>
              {activeSlashParent ? (
                <div className="border-border/70 border-b p-1.5">
                  <button
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={goBackSlashSubmenu}
                    onMouseDown={(event) => event.preventDefault()}
                    type="button"
                  >
                    <ChevronLeftIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {activeSlashParent.label ?? activeSlashParent.value}
                    </span>
                    <span className="shrink-0">Back</span>
                  </button>
                </div>
              ) : null}
              <CommandGroup
                className="px-2 py-1.5"
                heading={activeSlashParent?.label ?? "Commands"}
              >
                {filteredSlashCommands.length === 0 ? (
                  <CommandEmpty className="px-3 py-3 text-xs text-muted-foreground">
                    No matching commands
                  </CommandEmpty>
                ) : null}
                {filteredSlashCommands.map((command, index) => (
                  <CommandItem
                    className={cn(
                      "min-h-10 cursor-pointer gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted hover:text-foreground data-[highlighted=true]:bg-muted data-[highlighted=true]:text-foreground data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
                      command.disabled && "cursor-not-allowed opacity-50",
                      index === slashHighlightedIndex &&
                        "bg-muted text-foreground",
                    )}
                    data-highlighted={
                      index === slashHighlightedIndex ? "true" : undefined
                    }
                    key={command.id}
                    onMouseEnter={() => setSlashHighlightedIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onSelect={() => selectSlashCommand(command)}
                    ref={(node) => {
                      if (node) {
                        slashItemRefs.current.set(index, node);
                      } else {
                        slashItemRefs.current.delete(index);
                      }
                    }}
                    value={command.value}
                  >
                    <SlashCommandIcon command={command} />
                    <SlashCommandText command={command} />
                    {slashCommandHasChildren(command) ? (
                      <ChevronRightIcon className="ml-2 size-3.5 shrink-0 text-muted-foreground/70" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export type PromptInputHeaderProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  "align"
>;

export const PromptInputHeader = ({
  className,
  ...props
}: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("order-first flex-wrap gap-1", className)}
    {...props}
  />
);

export type PromptInputFooterProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  "align"
>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div
    className={cn("flex min-w-0 items-center gap-1", className)}
    {...props}
  />
);

export type PromptInputButtonTooltip =
  | string
  | {
      content: ReactNode;
      shortcut?: string;
      side?: ComponentProps<typeof TooltipContent>["side"];
    };

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
  tooltip?: PromptInputButtonTooltip;
};

/**
 * Resolves a PromptInputButtonTooltip value to a native title string.
 * Returns null when the tooltip content is not a plain string (e.g. a ReactNode),
 * in which case callers should fall back to the Tooltip component.
 */
function resolveTooltipTitle(
  tooltip: PromptInputButtonTooltip | undefined,
): string | null {
  if (tooltip == null) {
    return null;
  }
  const content = typeof tooltip === "string" ? tooltip : tooltip.content;
  if (typeof content !== "string") {
    return null;
  }
  const shortcut = typeof tooltip === "string" ? undefined : tooltip.shortcut;
  return shortcut ? `${content} (${shortcut})` : content;
}

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) => {
  const newSize =
    size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");

  const tooltipTitle = resolveTooltipTitle(tooltip);

  return (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      title={tooltipTitle ?? undefined}
      {...props}
    />
  );
};

export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;
export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => (
  <DropdownMenu {...props} />
);

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

export const PromptInputActionMenuTrigger = ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger asChild>
    <PromptInputButton className={className} {...props}>
      {children ?? <PlusIcon className="size-4" />}
    </PromptInputButton>
  </DropdownMenuTrigger>
);

export type PromptInputActionMenuContentProps = ComponentProps<
  typeof DropdownMenuContent
>;
export const PromptInputActionMenuContent = ({
  className,
  ...props
}: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent align="start" className={cn(className)} {...props} />
);

export type PromptInputActionMenuItemProps = ComponentProps<
  typeof DropdownMenuItem
>;
export const PromptInputActionMenuItem = ({
  className,
  ...props
}: PromptInputActionMenuItemProps) => (
  <DropdownMenuItem className={cn(className)} {...props} />
);

// Note: Actions that perform side-effects (like opening a file dialog)
// are provided in opt-in modules (e.g., prompt-input-attachments).

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
  onStop?: () => void;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === "submitted" || status === "streaming";
  const { canSubmit } = usePromptInputFormState();
  const disabled = props.disabled || (!isGenerating && !canSubmit);
  const disabledBecauseEmpty = !isGenerating && !canSubmit;
  const ariaDisabled = disabled ? true : props["aria-disabled"];

  let Icon = <CornerDownLeftIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Spinner />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (isGenerating && onStop) {
        e.preventDefault();
        onStop();
        return;
      }
      onClick?.(e);
    },
    [disabled, isGenerating, onStop, onClick],
  );

  return (
    <InputGroupButton
      aria-disabled={ariaDisabled}
      aria-label={isGenerating ? "Stop" : "Submit"}
      className={cn(
        disabledBecauseEmpty &&
          "cursor-not-allowed opacity-50 active:translate-y-0",
        className,
      )}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? "button" : "submit"}
      variant={variant}
      {...props}
      disabled={props.disabled}
    >
      {children ?? Icon}
    </InputGroupButton>
  );
};

export type PromptInputSelectProps = ComponentProps<typeof Select>;

export const PromptInputSelect = (props: PromptInputSelectProps) => (
  <Select {...props} />
);

export type PromptInputSelectTriggerProps = ComponentProps<
  typeof SelectTrigger
>;

export const PromptInputSelectTrigger = ({
  className,
  ...props
}: PromptInputSelectTriggerProps) => (
  <SelectTrigger
    className={cn(
      "border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors",
      "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
      className,
    )}
    {...props}
  />
);

export type PromptInputSelectContentProps = ComponentProps<
  typeof SelectContent
>;

export const PromptInputSelectContent = ({
  className,
  ...props
}: PromptInputSelectContentProps) => (
  <SelectContent className={cn(className)} {...props} />
);

export type PromptInputSelectItemProps = ComponentProps<typeof SelectItem>;

export const PromptInputSelectItem = ({
  className,
  ...props
}: PromptInputSelectItemProps) => (
  <SelectItem className={cn(className)} {...props} />
);

export type PromptInputSelectValueProps = ComponentProps<typeof SelectValue>;

export const PromptInputSelectValue = ({
  className,
  ...props
}: PromptInputSelectValueProps) => (
  <SelectValue className={cn(className)} {...props} />
);

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>;

export const PromptInputHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: PromptInputHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type PromptInputHoverCardTriggerProps = ComponentProps<
  typeof HoverCardTrigger
>;

export const PromptInputHoverCardTrigger = (
  props: PromptInputHoverCardTriggerProps,
) => <HoverCardTrigger {...props} />;

export type PromptInputHoverCardContentProps = ComponentProps<
  typeof HoverCardContent
>;

export const PromptInputHoverCardContent = ({
  align = "start",
  ...props
}: PromptInputHoverCardContentProps) => (
  <HoverCardContent align={align} {...props} />
);

export type PromptInputTabsListProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabsList = ({
  className,
  ...props
}: PromptInputTabsListProps) => <div className={cn(className)} {...props} />;

export type PromptInputTabProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTab = ({
  className,
  ...props
}: PromptInputTabProps) => <div className={cn(className)} {...props} />;

export type PromptInputTabLabelProps = HTMLAttributes<HTMLHeadingElement>;

export const PromptInputTabLabel = ({
  className,
  ...props
}: PromptInputTabLabelProps) => (
  // Content provided via children in props
  // oxlint-disable-next-line eslint-plugin-jsx-a11y(heading-has-content)
  <h3
    className={cn(
      "mb-2 px-3 font-medium text-muted-foreground text-xs",
      className,
    )}
    {...props}
  />
);

export type PromptInputTabBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabBody = ({
  className,
  ...props
}: PromptInputTabBodyProps) => (
  <div className={cn("space-y-1", className)} {...props} />
);

export type PromptInputTabItemProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabItem = ({
  className,
  ...props
}: PromptInputTabItemProps) => (
  <div
    className={cn(
      "flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent",
      className,
    )}
    {...props}
  />
);

export type PromptInputCommandProps = ComponentProps<typeof Command>;

export const PromptInputCommand = ({
  className,
  ...props
}: PromptInputCommandProps) => <Command className={cn(className)} {...props} />;

export type PromptInputCommandInputProps = ComponentProps<typeof CommandInput>;

export const PromptInputCommandInput = ({
  className,
  ...props
}: PromptInputCommandInputProps) => (
  <CommandInput className={cn(className)} {...props} />
);

export type PromptInputCommandListProps = ComponentProps<typeof CommandList>;

export const PromptInputCommandList = ({
  className,
  ...props
}: PromptInputCommandListProps) => (
  <CommandList className={cn(className)} {...props} />
);

export type PromptInputCommandEmptyProps = ComponentProps<typeof CommandEmpty>;

export const PromptInputCommandEmpty = ({
  className,
  ...props
}: PromptInputCommandEmptyProps) => (
  <CommandEmpty className={cn(className)} {...props} />
);

export type PromptInputCommandGroupProps = ComponentProps<typeof CommandGroup>;

export const PromptInputCommandGroup = ({
  className,
  ...props
}: PromptInputCommandGroupProps) => (
  <CommandGroup className={cn(className)} {...props} />
);

export type PromptInputCommandItemProps = ComponentProps<typeof CommandItem>;

export const PromptInputCommandItem = ({
  className,
  ...props
}: PromptInputCommandItemProps) => (
  <CommandItem className={cn(className)} {...props} />
);

export type PromptInputCommandSeparatorProps = ComponentProps<
  typeof CommandSeparator
>;

export const PromptInputCommandSeparator = ({
  className,
  ...props
}: PromptInputCommandSeparatorProps) => (
  <CommandSeparator className={cn(className)} {...props} />
);
