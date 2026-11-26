import { MAX_TEXT_CHARS } from "./limits";
import {
  cleanString,
  creatorNames,
  tagNames,
  titleOf,
  type ZoteroItemGroup,
  type ZoteroObject,
} from "./model";
import { noteHtmlToText } from "./note-text";

export type RenderItemInput = {
  group: ZoteroItemGroup;
  collectionPaths: string[];
  libraryType: "user" | "group";
  libraryId: string;
};

const TRUNCATION_MARKER = "[Content truncated]";
const FIELD_MAX = 2_000;
const ANNOTATION_MAX = 50_000;
const LABEL_MAX = 100;
const MAX_LISTED = 1_000;

/** Collapses every run of whitespace, so a value can never start a new block. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function line(value: unknown, max = FIELD_MAX): string | null {
  const text = cleanString(value, max);
  if (text === null) return null;
  const flat = oneLine(text);
  return flat === "" ? null : flat;
}

/** Truncates to `max` UTF-16 units without leaving half a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

function metadataList(input: RenderItemInput): string | null {
  const { item } = input.group;
  const rows: string[] = [`- Item type: ${oneLine(item.itemType)}`];
  const creators = creatorNames(item.data.creators).map((name) =>
    oneLine(name),
  );
  if (creators.length > 0) rows.push(`- Creators: ${creators.join(", ")}`);
  const fields: Array<[string, unknown]> = [
    ["Date", item.data.date],
    ["Publication", item.data.publicationTitle],
    ["DOI", item.data.DOI],
    ["ISBN", item.data.ISBN],
    ["URL", item.data.url],
  ];
  for (const [label, value] of fields) {
    const text = line(value);
    if (text !== null) rows.push(`- ${label}: ${text}`);
  }
  rows.push(
    `- Library: ${oneLine(input.libraryType)} ${oneLine(input.libraryId)}`,
  );
  return rows.join("\n");
}

function noteBodies(notes: ZoteroObject[]): string[] {
  const bodies: string[] = [];
  for (const note of notes) {
    if (typeof note.data.note !== "string") continue;
    const text = noteHtmlToText(note.data.note);
    if (text !== "") bodies.push(text);
  }
  return bodies;
}

function attachmentTitle(attachment: ZoteroObject): string {
  return (
    line(attachment.data.title) ??
    line(attachment.data.filename) ??
    "Untitled attachment"
  );
}

function attachmentLine(attachment: ZoteroObject): string {
  const contentType = line(attachment.data.contentType);
  const linkMode = line(attachment.data.linkMode);
  return (
    `- ${attachmentTitle(attachment)}` +
    (contentType !== null ? ` (${contentType})` : "") +
    (linkMode !== null ? `, ${linkMode}` : "")
  );
}

/** The 1-based page from an annotation's `annotationPosition` JSON, if any. */
function pageFromPosition(value: unknown): number | null {
  let position: unknown = value;
  if (typeof value === "string") {
    try {
      position = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof position !== "object" || position === null) return null;
  const pageIndex = (position as { pageIndex?: unknown }).pageIndex;
  return typeof pageIndex === "number" &&
    Number.isSafeInteger(pageIndex) &&
    pageIndex >= 0
    ? pageIndex + 1
    : null;
}

function annotationBlock(annotation: ZoteroObject): string | null {
  const { data } = annotation;
  const text =
    typeof data.annotationText === "string" ? data.annotationText.trim() : "";
  const comment = line(data.annotationComment, ANNOTATION_MAX);
  if (text === "" && comment === null) return null;

  const label = line(data.annotationPageLabel, LABEL_MAX);
  const page = label ?? pageFromPosition(data.annotationPosition);
  const type = line(data.annotationType, LABEL_MAX);
  const head = [page !== null ? `p. ${page}` : null, type]
    .filter((part): part is string => part !== null)
    .join(", ");

  const blocks = [`- ${head === "" ? "Annotation" : head}`];
  if (text !== "") {
    blocks.push(
      cut(text, ANNOTATION_MAX)
        .split(/\r\n|[\r\n\u2028\u2029]/)
        .map((quoted) => `> ${quoted}`)
        .join("\n"),
    );
  }
  if (comment !== null) blocks.push(`Comment: ${comment}`);
  return blocks.join("\n\n");
}

/**
 * Renders one Zotero item, with its notes, attachment list and annotations,
 * as Markdown for indexing. Attachment bytes are never read. Sections with no
 * content are omitted; annotation text is always emitted as quoted lines so
 * its Markdown never forms structure of its own. The result is cut so it,
 * including the final `[Content truncated]` line, fits in MAX_TEXT_CHARS.
 */
export function renderItemMarkdown(input: RenderItemInput): string {
  const { group } = input;
  const sections: string[] = [`# ${oneLine(titleOf(group.item))}`];
  let size = sections[0]?.length ?? 0;
  const full = (): boolean => size > MAX_TEXT_CHARS;
  const add = (section: string): void => {
    sections.push(section);
    size += section.length + 2;
  };

  if (group.item.itemType === "note") {
    const text =
      typeof group.item.data.note === "string"
        ? noteHtmlToText(group.item.data.note)
        : "";
    if (text !== "") add(text);
  } else {
    add(metadataList(input) as string);

    const abstract =
      typeof group.item.data.abstractNote === "string"
        ? group.item.data.abstractNote.trim()
        : "";
    if (abstract !== "") add(`## Abstract\n\n${cut(abstract, MAX_TEXT_CHARS)}`);

    const collections = input.collectionPaths
      .map((path) => line(path))
      .filter((path): path is string => path !== null)
      .slice(0, MAX_LISTED);
    if (collections.length > 0) {
      add(`## Collections\n\n${collections.map((p) => `- ${p}`).join("\n")}`);
    }

    const tags = tagNames(group.item.data.tags)
      .map((tag) => oneLine(tag))
      .filter((tag) => tag !== "");
    if (tags.length > 0) {
      add(`## Tags\n\n${tags.map((tag) => `- ${tag}`).join("\n")}`);
    }

    const notes: string[] = [];
    let notesSize = 0;
    for (const body of noteBodies(group.notes)) {
      notes.push(body);
      notesSize += body.length;
      if (notesSize > MAX_TEXT_CHARS) break;
    }
    if (notes.length > 0) add(`## Notes\n\n${notes.join("\n\n---\n\n")}`);

    if (group.attachments.length > 0) {
      add(
        `## Attachments\n\n${group.attachments
          .slice(0, MAX_LISTED)
          .map(({ attachment }) => attachmentLine(attachment))
          .join("\n")}`,
      );
    }

    const annotationSections: string[] = [];
    for (const { attachment, annotations } of group.attachments) {
      if (full()) break;
      const blocks: string[] = [];
      let blocksSize = 0;
      for (const annotation of annotations) {
        const block = annotationBlock(annotation);
        if (block === null) continue;
        blocks.push(block);
        blocksSize += block.length;
        if (blocksSize > MAX_TEXT_CHARS) break;
      }
      if (blocks.length > 0) {
        annotationSections.push(
          `### ${attachmentTitle(attachment)}\n\n${blocks.join("\n\n")}`,
        );
      }
    }
    if (annotationSections.length > 0) {
      add(`## Annotations\n\n${annotationSections.join("\n\n")}`);
    }
  }

  const markdown = sections.join("\n\n");
  if (markdown.length <= MAX_TEXT_CHARS) return markdown;
  const marker = `\n\n${TRUNCATION_MARKER}`;
  return cut(markdown, MAX_TEXT_CHARS - marker.length) + marker;
}
