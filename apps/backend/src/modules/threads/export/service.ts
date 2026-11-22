import type { ExportThreadLocale } from "@sourceweft/contracts";
import { buildArtifactPreviewUrl } from "@sourceweft/contracts/artifact-urls";
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import { findArtifactRecord } from "../../artifacts/repository";
import { contentArtifactsService } from "../../artifacts/service";
import { ContentError } from "../../content/errors";
import type { MessageRecord } from "../../content/types";
import { downloadChatImageObject } from "../../sources/storage";
import {
  canViewContent,
  canViewThread,
} from "../../workspace/content-visibility";
import { requireContentWorkspace } from "../../workspace/guards";
import { resolvePersona } from "../agent";
import { findActiveChatThreadRun } from "../durable/repository";
import { listMessageRecordsByThread } from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import { extractImagePartsFromContentJson } from "../turn/message-image-parts";
import { readCitationRecords } from "./citations";
import { exportFileBaseName } from "./file-name";
import type { ArtifactType } from "./labels";
import { renderChatMarkdown, type RenderableMessage } from "./markdown";
import { collectMessageArtifactIds, selectExportMessages } from "./messages";
import { findUserDisplayNames } from "./repository";

export const EXPORT_IMAGE_LIMITS = { count: 50, bytes: 200 * 1024 * 1024 };

export type ThreadExport =
  | { kind: "markdown"; fileName: string; text: string }
  | { kind: "zip"; fileName: string; stream: ReadableStream<Uint8Array> };

/** One image the zip should hold, fetched only when the archive gets to it. */
type ImageSlot = {
  image: { name: string; path: string | null };
  fetch: () => Promise<{ bytes: Uint8Array; name: string; mimeType: string }>;
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

function imageFileName(name: string, mimeType: string, n: number) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const fromName = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const extension =
    IMAGE_EXTENSIONS[mimeType.toLowerCase()] ||
    (/^[a-z0-9]{1,5}$/.test(fromName) ? fromName : "bin");
  const safeStem = exportFileBaseName(stem).replace(/\s+/g, "-");
  return `images/${String(n).padStart(2, "0")}-${safeStem}.${extension}`;
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  throw new Error("Unsupported image body");
}

/**
 * Streams a zip: every image slot is fetched and added in turn, then the
 * Markdown (which needs to know which images made it) is added last. Work
 * happens only as the reader pulls, so one image is in memory at a time.
 */
function zipStream(input: {
  slots: ImageSlot[];
  limits: { count: number; bytes: number };
  markdownName: string;
  renderMarkdown: () => string;
  logContext: Record<string, string>;
}): ReadableStream<Uint8Array> {
  const pending: Uint8Array[] = [];
  let finished = false;
  let failure: unknown = null;
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      return;
    }
    pending.push(chunk);
    if (final) {
      finished = true;
    }
  });

  let index = 0;
  let included = 0;
  let totalBytes = 0;

  async function addNextImage(slot: ImageSlot) {
    if (included >= input.limits.count) {
      return;
    }
    try {
      const file = await slot.fetch();
      if (totalBytes + file.bytes.byteLength > input.limits.bytes) {
        return;
      }
      const path = imageFileName(file.name, file.mimeType, included + 1);
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      entry.push(file.bytes, true);
      included += 1;
      totalBytes += file.bytes.byteLength;
      slot.image.path = path;
    } catch (error) {
      logger.warn("Chat export image unavailable", {
        ...input.logContext,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (pending.length === 0 && !finished) {
          const slot = input.slots[index];
          if (slot) {
            index += 1;
            await addNextImage(slot);
          } else {
            const markdown = new ZipDeflate(input.markdownName, { level: 6 });
            zip.add(markdown);
            markdown.push(strToU8(input.renderMarkdown()), true);
            zip.end();
          }
          if (failure) {
            throw failure;
          }
        }
        while (pending.length > 0) {
          controller.enqueue(pending.shift()!);
        }
        if (finished) {
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/**
 * Builds the export of one chat for a member who can read it: the Markdown
 * alone, or a zip with the Markdown and an `images/` folder when the chat has
 * images. A missing or invisible chat is `THREAD_NOT_FOUND`.
 */
export async function exportThread(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  locale: ExportThreadLocale;
  timeZone: string;
  now?: Date;
  limits?: { count: number; bytes: number };
}): Promise<ThreadExport> {
  const workspace = await requireContentWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });
  const scope = {
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  };
  const thread = await findThreadRecord({ ...scope, threadId: input.threadId });
  if (!thread || !canViewThread(input.userId, thread)) {
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  }

  const [stored, activeRun, persona] = await Promise.all([
    listMessageRecordsByThread({ ...scope, threadId: thread.id }),
    findActiveChatThreadRun({ ...scope, threadId: thread.id }),
    resolvePersona({ ...scope, personaId: thread.personaId }),
  ]);
  const messages = selectExportMessages(
    stored,
    activeRun?.assistantMessageId ?? null,
  );
  const names = await findUserDisplayNames(
    messages.flatMap((message) =>
      message.role === "user" && message.createdBy ? [message.createdBy] : [],
    ),
  );

  const slots: ImageSlot[] = [];
  const renderable: RenderableMessage[] = [];
  for (const message of messages) {
    renderable.push(
      await toRenderable({
        message,
        scope,
        userId: input.userId,
        author:
          message.role === "user"
            ? (message.createdBy && names.get(message.createdBy)) || null
            : (persona?.name ?? null),
        slots,
      }),
    );
  }

  const baseName = exportFileBaseName(thread.title);
  const renderMarkdown = () =>
    renderChatMarkdown({
      title: thread.title,
      exportedAt: input.now ?? new Date(),
      timeZone: input.timeZone,
      locale: input.locale,
      messages: renderable,
    });

  if (slots.length === 0) {
    return {
      kind: "markdown",
      fileName: `${baseName}.md`,
      text: renderMarkdown(),
    };
  }
  return {
    kind: "zip",
    fileName: `${baseName}.zip`,
    stream: zipStream({
      slots,
      limits: input.limits ?? EXPORT_IMAGE_LIMITS,
      markdownName: `${baseName}.md`,
      renderMarkdown,
      logContext: { threadId: thread.id, workspaceId: workspace.id },
    }),
  };
}

async function toRenderable(input: {
  message: MessageRecord;
  scope: { teamId: string; workspaceId: string };
  userId: string;
  author: string | null;
  slots: ImageSlot[];
}): Promise<RenderableMessage> {
  const { message, scope } = input;
  const attachments: RenderableMessage["attachments"] = [];
  for (const part of extractImagePartsFromContentJson(message.contentJson)) {
    const image = { name: part.fileName, path: null };
    attachments.push(image);
    input.slots.push({
      image,
      fetch: async () => ({
        bytes: toBytes(
          await downloadChatImageObject({
            bucket: part.storageBucket,
            key: part.storageKey,
          }),
        ),
        name: part.fileName,
        mimeType: part.mimeType,
      }),
    });
  }

  const generatedImages: RenderableMessage["generatedImages"] = [];
  const artifactLinks: RenderableMessage["artifactLinks"] = [];
  if (message.role === "assistant") {
    for (const artifactId of collectMessageArtifactIds(message.metadata)) {
      const artifact = await findArtifactRecord({ ...scope, artifactId });
      if (
        !artifact ||
        artifact.status !== "ready" ||
        !canViewContent(input.userId, artifact)
      ) {
        continue;
      }
      const title = artifact.title?.trim() || artifactId;
      if (artifact.artifactType === "image") {
        const image = { artifactId, name: title, path: null };
        generatedImages.push(image);
        input.slots.push({
          image,
          fetch: async () => {
            const file = await contentArtifactsService.getArtifactFile({
              workspaceId: scope.workspaceId,
              artifactId,
              userId: input.userId,
            });
            return {
              bytes: toBytes(file.body),
              name: file.fileName || title,
              mimeType: file.contentType || "application/octet-stream",
            };
          },
        });
        continue;
      }
      artifactLinks.push({
        kind: artifact.artifactType as ArtifactType,
        title,
        url: `${config.auth.webBaseUrl}${buildArtifactPreviewUrl({
          workspaceId: scope.workspaceId,
          artifactId,
        })}`,
      });
    }
  }

  return {
    role: message.role === "assistant" ? "assistant" : "user",
    author: input.author,
    createdAt: new Date(message.createdAt),
    content: message.content,
    stopped: message.metadata.isCancelled === true,
    citations:
      message.role === "assistant" ? readCitationRecords(message.metadata) : [],
    attachments,
    generatedImages,
    artifactLinks,
  };
}
