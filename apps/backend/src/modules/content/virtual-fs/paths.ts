import type { VirtualFsSource, VirtualPathTarget } from "./types";

const KB_ROOT = "/kb";

export function normalizeVirtualPath(path: string | undefined | null) {
  const raw = typeof path === "string" && path.trim().length > 0 ? path.trim() : KB_ROOT;
  const withRoot = raw.startsWith("/") ? raw : `/${raw}`;
  const normalized = withRoot.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

  if (normalized.includes("..") || normalized.includes("~")) {
    throw new Error(`EINVAL: invalid virtual path '${raw}'`);
  }

  if (normalized !== "/" && normalized !== KB_ROOT && !normalized.startsWith(`${KB_ROOT}/`)) {
    throw new Error(`ENOENT: virtual filesystem only exposes /kb, got '${raw}'`);
  }

  return normalized;
}

export function safeVirtualName(value: string | null | undefined, fallback: string) {
  const base = (value || fallback || "source").trim().normalize("NFKC");
  const withoutExtension = base.replace(/\.[a-z0-9]{1,8}$/i, "");
  const safe = withoutExtension
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return safe || fallback.slice(0, 12) || "source";
}

export function buildVirtualSource(input: {
  sourceId: string;
  title: string;
  fileName: string | null;
  chunkCount: number;
  sizeBytes: number | null;
  mimeType: string | null;
  updatedAt: Date | string;
}): VirtualFsSource {
  const shortId = input.sourceId.slice(0, 8);
  const safeName = safeVirtualName(input.fileName || input.title, input.sourceId);
  const basePath = `${KB_ROOT}/${safeName}__src_${shortId}`;
  return {
    ...input,
    safeName,
    shortId,
    filePath: `${basePath}.md`,
    dirPath: basePath,
  };
}

export function buildChunkFilePath(source: VirtualFsSource, chunkNo: number) {
  return `${source.dirPath}/chunks/${String(chunkNo).padStart(4, "0")}.md`;
}

export function parseVirtualPath(path: string, sources: VirtualFsSource[]): VirtualPathTarget {
  const normalized = normalizeVirtualPath(path);
  if (normalized === "/") {
    return { kind: "root" };
  }
  if (normalized === KB_ROOT) {
    return { kind: "kbRoot" };
  }

  const source = sources.find(
    (candidate) =>
      normalized === candidate.filePath ||
      normalized === candidate.dirPath ||
      normalized === `${candidate.dirPath}/chunks` ||
      normalized.startsWith(`${candidate.dirPath}/chunks/`),
  );

  if (!source) {
    throw new Error(`ENOENT: no such file or directory, '${normalized}'`);
  }

  if (normalized === source.filePath) {
    return { kind: "sourceFile", sourceId: source.sourceId };
  }
  if (normalized === source.dirPath) {
    return { kind: "sourceDir", sourceId: source.sourceId };
  }
  if (normalized === `${source.dirPath}/chunks`) {
    return { kind: "chunksDir", sourceId: source.sourceId };
  }

  const chunkMatch = normalized.match(/\/chunks\/(\d+)\.md$/);
  if (!chunkMatch) {
    throw new Error(`ENOENT: no such file or directory, '${normalized}'`);
  }

  return {
    kind: "chunkFile",
    sourceId: source.sourceId,
    chunkNo: Number(chunkMatch[1]),
  };
}

export function findVirtualSource(sources: VirtualFsSource[], sourceId: string) {
  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  if (!source) {
    throw new Error(`ENOENT: source '${sourceId}' is not visible in /kb`);
  }
  return source;
}
