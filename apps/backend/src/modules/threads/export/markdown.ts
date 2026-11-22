import type { ExportThreadLocale } from "@sourceweft/contracts";
import { createFootnotes, formatFootnote, type ExportCitation } from "./citations";
import { exportLabels, type ArtifactType, type ExportLabels } from "./labels";

/** An image in the export; a null path means it could not be included. */
export type ExportImage = { name: string; path: string | null };

export type RenderableMessage = {
  role: "user" | "assistant";
  /** Display name for user messages, persona name for replies; null → label. */
  author: string | null;
  createdAt: Date;
  content: string;
  stopped: boolean;
  citations: ExportCitation[];
  attachments: ExportImage[];
  generatedImages: Array<ExportImage & { artifactId: string }>;
  artifactLinks: Array<{
    kind: ArtifactType | null;
    title: string;
    url: string;
  }>;
};

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeLinkText(value: string) {
  return oneLine(value).replace(/([[\]\\])/g, "\\$1");
}

/**
 * The title as an ATX heading's text. Nothing at its start begins a block
 * there; only a trailing ` #…` would be read as the closing sequence.
 */
function escapeTitle(value: string) {
  return oneLine(value).replace(/(\s)(#+)$/, "$1\\$2");
}

function formatTime(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function imageMarkdown(image: ExportImage, labels: ExportLabels) {
  return image.path
    ? `![${escapeLinkText(image.name)}](${image.path})`
    : `[${labels.imageUnavailable}: ${escapeLinkText(image.name)}]`;
}

function referencedArtifactId(url: string) {
  return (
    /\/artifacts\/([^/?#]+)/.exec(url)?.[1] ??
    /[?&]artifactId=([^&#]+)/.exec(url)?.[1] ??
    null
  );
}

/**
 * Puts each generated image where the answer already points at it, and
 * returns the ones the answer never mentions so they can be appended. The
 * caller decides how a placed image renders (export Markdown, a snapshot
 * placeholder, …) via `render`.
 */
export function placeGeneratedImages<Image extends { artifactId: string }>(
  content: string,
  images: Image[],
  render: (image: Image) => string,
): { text: string; remaining: Image[] } {
  const byId = new Map(images.map((image) => [image.artifactId, image]));
  const placed = new Set<string>();
  const text = content.replace(MARKDOWN_IMAGE, (markdown, url: string) => {
    const id = referencedArtifactId(url);
    const image = id ? byId.get(decodeURIComponent(id)) : undefined;
    if (!image) {
      return markdown;
    }
    if (placed.has(image.artifactId)) {
      return "";
    }
    placed.add(image.artifactId);
    return render(image);
  });
  return {
    text,
    remaining: images.filter((image) => !placed.has(image.artifactId)),
  };
}

/** The whole chat as one Markdown document. Pure: no I/O. */
export function renderChatMarkdown(input: {
  title: string;
  exportedAt: Date;
  timeZone: string;
  locale: ExportThreadLocale;
  messages: RenderableMessage[];
}): string {
  const labels = exportLabels(input.locale);
  const footnotes = createFootnotes();
  const blocks: string[] = [
    `# ${escapeTitle(input.title)}`,
    `> ${labels.exportedFrom} · ${formatTime(input.exportedAt, input.timeZone)}`,
  ];

  for (const message of input.messages) {
    const author =
      (message.author && oneLine(message.author)) ||
      (message.role === "user" ? labels.user : labels.assistant);
    blocks.push(
      `## ${author} · ${formatTime(message.createdAt, input.timeZone)}`,
    );

    const placed = placeGeneratedImages(
      message.content,
      message.generatedImages,
      (image) => imageMarkdown(image, labels),
    );
    const cited = footnotes.replace(placed.text, message.citations);
    const body = cited.text.replace(/\n{3,}/g, "\n\n").trim();
    if (body) {
      blocks.push(body);
    }
    for (const image of [...message.attachments, ...placed.remaining]) {
      blocks.push(imageMarkdown(image, labels));
    }
    for (const link of message.artifactLinks) {
      const kind = link.kind ? labels.artifactKinds[link.kind] : labels.file;
      blocks.push(`[${kind}: ${escapeLinkText(link.title)}](${link.url})`);
    }
    if (message.stopped) {
      blocks.push(`_(${labels.stopped})_`);
    }
    if (cited.added.length > 0) {
      blocks.push(
        cited.added
          .map(({ n, record }) => formatFootnote(n, record, labels.source))
          .join("\n"),
      );
    }
  }

  return `${blocks.join("\n\n")}\n`;
}
