import { readSkillBlob } from "./storage";
import type {
  EnabledSkillDescriptor,
  SkillFileContent,
  SkillFileManifestEntry,
  SkillFileReader,
} from "./types";

/**
 * Reading ONE skill file's content, whatever stores it.
 *
 * A turn is handed a manifest (paths, types, sizes, digests) and fetches a body
 * only when something actually reads it. The model reads text; bytes it cannot
 * read (fonts, images, archives) are never fetched for it — scripts get them
 * from the staged bundle in the sandbox instead.
 */

const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-python",
  "application/x-python-code",
  "application/sql",
  "application/graphql",
  "application/x-httpd-php",
  "application/x-ndjson",
  "image/svg+xml",
]);

/**
 * Whether a manifest row is text the model can read. Decided from the stored
 * MIME type alone, so listing and grep never have to open a file to find out.
 */
export function isTextSkillMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]!.trim().toLowerCase();
  return (
    normalized.startsWith("text/") ||
    TEXT_APPLICATION_MIME_TYPES.has(normalized) ||
    /\+(?:json|xml|yaml)$/u.test(normalized)
  );
}

/**
 * Text decode with a safety net: a blob whose MIME type claims text but whose
 * bytes are not (a NUL, or invalid UTF-8) is reported as binary rather than
 * handed to the model as mojibake.
 */
export function decodeSkillFileBytes(bytes: Uint8Array): SkillFileContent {
  if (bytes.includes(0)) {
    return { binary: true, sizeBytes: bytes.byteLength };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { binary: true, sizeBytes: bytes.byteLength };
  }
}

/** One file of an `object` version. A binary row is answered without a fetch. */
export async function readSkillObjectFile(input: {
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<SkillFileContent> {
  if (!isTextSkillMimeType(input.mimeType)) {
    return { binary: true, sizeBytes: input.sizeBytes };
  }
  return decodeSkillFileBytes(
    await readSkillBlob({
      objectKey: input.objectKey,
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  );
}

/**
 * Wraps a per-path fetch into the descriptor's `readFile`: unknown paths are
 * refused from the manifest, and each file is fetched at most once for the
 * life of the descriptor — i.e. once per turn, since descriptors are resolved
 * per turn. A failed fetch is forgotten so the next read can retry.
 */
export function createSkillFileReader(input: {
  files: readonly SkillFileManifestEntry[];
  fetch: (file: SkillFileManifestEntry) => Promise<SkillFileContent>;
}): SkillFileReader {
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const cache = new Map<string, Promise<SkillFileContent>>();
  return (path) => {
    const file = byPath.get(path);
    if (!file) {
      return Promise.reject(new Error(`ENOENT: no such skill file '${path}'`));
    }
    if (!file.isText) {
      return Promise.resolve({ binary: true, sizeBytes: file.sizeBytes });
    }
    let pending = cache.get(path);
    if (!pending) {
      pending = input.fetch(file);
      cache.set(path, pending);
      pending.catch(() => {
        if (cache.get(path) === pending) {
          cache.delete(path);
        }
      });
    }
    return pending;
  };
}

/**
 * Descriptor content for a builtin, read from disk. Text bodies are already in
 * memory, so the "lazy" reader is just a lookup, and SKILL.md is there up front
 * like for every other storage type. A binary file is answered as binary — the
 * model is never handed bytes — and `readBytes` reaches it for the one consumer
 * that needs them: the sandbox bundle.
 */
export function inlineSkillContent(
  bundleFiles: ReadonlyArray<
    {
      path: string;
      mimeType: string;
      sizeBytes: number;
      contentHash: string;
    } &
      // `isText` may be omitted for text: callers holding plain text need not say so.
      (
        | { isText?: true; contentText: string }
        | {
            isText: false;
            contentText: null;
            readBytes: () => Promise<Uint8Array>;
          }
      )
  >,
): Pick<
  EnabledSkillDescriptor,
  "files" | "skillMd" | "readFile" | "readBytes"
> {
  const byPath = new Map(bundleFiles.map((file) => [file.path, file]));
  const missing = (path: string) =>
    new Error(`ENOENT: no such skill file '${path}'`);
  const skillMd = byPath.get("SKILL.md");
  return {
    files: bundleFiles.map((file) => ({
      path: file.path,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      contentHash: file.contentHash,
      isText: file.isText !== false,
    })),
    skillMd:
      skillMd && skillMd.isText !== false ? skillMd.contentText : undefined,
    readFile: async (path) => {
      const file = byPath.get(path);
      if (!file) throw missing(path);
      return file.isText === false
        ? { binary: true, sizeBytes: file.sizeBytes }
        : { text: file.contentText };
    },
    readBytes: async (path) => {
      const file = byPath.get(path);
      if (!file) throw missing(path);
      return file.isText === false
        ? file.readBytes()
        : new TextEncoder().encode(file.contentText);
    },
  };
}
