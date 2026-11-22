import type { MessageRecord } from "../../content/types";
import {
  CODE_PATTERN,
  createFootnotes,
  readCitationRecords,
  type ExportCitation,
} from "../export/citations";
import { exportLabels, type ArtifactType } from "../export/labels";
import { placeGeneratedImages, referencedArtifactId } from "../export/markdown";
import {
  collectMessageArtifactIds,
  selectExportMessages,
} from "../export/messages";
import { extractImagePartsFromContentJson } from "../turn/message-image-parts";

/** Ready, viewable artifacts a reply produced, keyed by artifact id. */
export type SnapshotArtifact = {
  kind: ArtifactType;
  title: string;
  mimeType: string | null;
};

export type ChatSnapshotMessage = {
  role: "user" | "assistant";
  createdAt: string;
  content: string;
  stopped: boolean;
  citations: Array<{ n: number; title: string; url: string | null }>;
  images: Array<{ n: number; name: string }>;
  artifacts: Array<{ artifactId: string; kind: ArtifactType; title: string }>;
};

export type ChatSnapshotImage =
  | {
      n: number;
      source: "attachment";
      bucket: string | null;
      key: string;
      mimeType: string;
    }
  | {
      n: number;
      source: "artifact";
      artifactId: string;
      mimeType: string | null;
    };

export type ChatSnapshot = {
  title: string;
  assistantName: string | null;
  takenAt: string;
  messages: ChatSnapshotMessage[];
  images: ChatSnapshotImage[];
};

const SOURCE_LABEL = exportLabels("en").source;

/** Mirrors `markdown.ts`'s `escapeLinkText`, which is not exported. */
function escapeAltText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([[\]\\])/g, "\\$1");
}

type PlacedImage = { artifactId: string; n: number; name: string };

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isWorkspaceApiUrl(url: string) {
  return url.includes("/v1/workspaces/");
}

/**
 * A public snapshot must not carry workspace or artifact ids. Any Markdown
 * image still pointing at an internal artifact after placement (its artifact
 * missing, not ready, not viewable or not an image) is reduced to its alt
 * text, and a link into the workspace API to its link text. Code is left
 * alone, like the citation rewrite.
 */
function stripInternalArtifactReferences(content: string) {
  return content
    .split(CODE_PATTERN)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment
            .replace(MARKDOWN_IMAGE, (markdown, alt: string, url: string) =>
              referencedArtifactId(url) || isWorkspaceApiUrl(url)
                ? alt
                : markdown,
            )
            .replace(MARKDOWN_LINK, (markdown, text: string, url: string) =>
              isWorkspaceApiUrl(url) ||
              (url.startsWith("/") && referencedArtifactId(url))
                ? text
                : markdown,
            ),
    )
    .join("");
}

/**
 * Builds the frozen snapshot of a chat: the same message selection and
 * citation/image rewriting as the Markdown export, kept as structured data
 * instead of Markdown text, and with no member identity, tool output,
 * reasoning, model name or credits — only the content shown ever crosses in.
 *
 * Pure: no I/O. `artifacts` must already be filtered to ready artifacts the
 * sharer can view; an id missing from it is silently dropped.
 */
export function buildChatSnapshot(input: {
  title: string;
  assistantName: string | null;
  takenAt: Date;
  messages: MessageRecord[];
  activeAssistantMessageId: string | null;
  artifacts: Map<string, SnapshotArtifact>;
}): ChatSnapshot {
  const selected = selectExportMessages(
    input.messages,
    input.activeAssistantMessageId,
  );
  const footnotes = createFootnotes();
  const images: ChatSnapshotImage[] = [];
  let nextImage = 0;

  const messages = selected.map((message): ChatSnapshotMessage => {
    const messageImages: Array<{ n: number; name: string }> = [];

    for (const part of extractImagePartsFromContentJson(message.contentJson)) {
      nextImage += 1;
      const n = nextImage;
      images.push({
        n,
        source: "attachment",
        bucket: part.storageBucket ?? null,
        key: part.storageKey,
        mimeType: part.mimeType,
      });
      messageImages.push({ n, name: part.fileName });
    }

    const placedImages: PlacedImage[] = [];
    const artifacts: ChatSnapshotMessage["artifacts"] = [];

    if (message.role === "assistant") {
      for (const artifactId of collectMessageArtifactIds(message.metadata)) {
        const artifact = input.artifacts.get(artifactId);
        if (!artifact) {
          continue;
        }
        if (artifact.kind === "image") {
          nextImage += 1;
          const n = nextImage;
          images.push({
            n,
            source: "artifact",
            artifactId,
            mimeType: artifact.mimeType,
          });
          placedImages.push({ artifactId, n, name: artifact.title });
          continue;
        }
        artifacts.push({
          artifactId,
          kind: artifact.kind,
          title: artifact.title,
        });
      }
    }

    const placed = placeGeneratedImages(
      message.content,
      placedImages,
      (image) => `![${escapeAltText(image.name)}](sw-image:${image.n})`,
    );
    for (const image of placed.remaining) {
      messageImages.push({ n: image.n, name: image.name });
    }

    const records: ExportCitation[] =
      message.role === "assistant"
        ? readCitationRecords(message.metadata).map((record) => ({
            ...record,
            quote: null,
          }))
        : [];
    const cited = footnotes.replace(
      stripInternalArtifactReferences(placed.text),
      records,
    );
    const citations = cited.added.map(({ n, record }) => ({
      n,
      title: record.sourceTitle ?? SOURCE_LABEL,
      url: record.externalUri,
    }));

    return {
      role: message.role === "assistant" ? "assistant" : "user",
      createdAt: message.createdAt,
      content: cited.text,
      stopped: message.metadata.isCancelled === true,
      citations,
      images: messageImages,
      artifacts,
    };
  });

  return {
    title: input.title,
    assistantName: input.assistantName,
    takenAt: input.takenAt.toISOString(),
    messages,
    images,
  };
}
