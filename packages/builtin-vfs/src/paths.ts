import type { VirtualFsSource, VirtualPathTarget } from "./types";

const KB_ROOT = "/kb";

export type BuildVirtualSourceInput = {
  readonly sourceId: string;
  readonly sourceType?: VirtualFsSource["sourceType"];
  readonly parentSourceId?: string | null;
  readonly title: string;
  readonly fileName: string | null;
  readonly chunkCount: number;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
  readonly updatedAt: Date | string;
  readonly parentDirPath?: string;
};

export function normalizeVirtualPath(path: string | undefined | null) {
  const raw =
    typeof path === "string" && path.trim().length > 0 ? path.trim() : KB_ROOT;
  const withRoot = raw.startsWith("/") ? raw : `/${raw}`;
  const normalized = withRoot.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

  if (normalized.includes("..") || normalized.includes("~")) {
    throw new Error(`EINVAL: invalid virtual path '${raw}'`);
  }

  if (
    normalized !== "/" &&
    normalized !== KB_ROOT &&
    !normalized.startsWith(`${KB_ROOT}/`)
  ) {
    throw new Error(`ENOENT: virtual filesystem only exposes /kb, got '${raw}'`);
  }

  return normalized;
}

export function safeVirtualName(
  value: string | null | undefined,
  fallback: string,
) {
  const base = (value || fallback || "source").trim().normalize("NFKC");
  const withoutExtension = base.replace(/\.[a-z0-9]{1,8}$/i, "");
  const safe = withoutExtension
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return safe || fallback.slice(0, 12) || "source";
}

export function buildVirtualSource(
  input: BuildVirtualSourceInput,
): VirtualFsSource {
  const shortId = input.sourceId.slice(0, 8);
  const sourceType = input.sourceType ?? "manual_upload";
  const safeName = safeVirtualName(
    input.fileName || input.title,
    input.sourceId,
  );
  const parentDirPath = input.parentDirPath ?? KB_ROOT;
  const basePath =
    sourceType === "directory"
      ? `${parentDirPath}/${safeName}`.replace(/\/+/g, "/")
      : `${parentDirPath}/${safeName}__src_${shortId}`.replace(/\/+/g, "/");
  return {
    ...input,
    sourceType,
    parentSourceId: input.parentSourceId ?? null,
    safeName,
    shortId,
    filePath: sourceType === "directory" ? null : `${basePath}.md`,
    dirPath: basePath,
    readmePath: sourceType === "directory" ? `${basePath}/README.md` : null,
  };
}

export function buildChunkFilePath(source: VirtualFsSource, chunkNo: number) {
  return `${source.dirPath}/chunks/${String(chunkNo).padStart(4, "0")}.md`;
}

export function buildVirtualSourceTree(
  inputs: readonly BuildVirtualSourceInput[],
): VirtualFsSource[] {
  const byParent = new Map<string | null, BuildVirtualSourceInput[]>();
  for (const input of inputs) {
    const parentId = input.parentSourceId ?? null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(input);
    byParent.set(parentId, siblings);
  }

  const built = new Map<string, VirtualFsSource>();
  const ordered: VirtualFsSource[] = [];
  const visiting = new Set<string>();

  function buildNode(input: BuildVirtualSourceInput, parentDirPath = KB_ROOT) {
    const existing = built.get(input.sourceId);
    if (existing) {
      return existing;
    }
    if (visiting.has(input.sourceId)) {
      return buildVirtualSource({
        ...input,
        parentDirPath: KB_ROOT,
        parentSourceId: null,
      });
    }
    visiting.add(input.sourceId);

    const parent = input.parentSourceId ? built.get(input.parentSourceId) : null;
    const resolvedParentDirPath =
      parent?.sourceType === "directory" ? parent.dirPath : parentDirPath;
    const source = buildVirtualSource({
      ...input,
      parentDirPath: resolvedParentDirPath,
    });
    visiting.delete(input.sourceId);
    built.set(source.sourceId, source);
    ordered.push(source);

    const children = byParent.get(input.sourceId) ?? [];
    for (const child of children) {
      buildNode(
        child,
        source.sourceType === "directory" ? source.dirPath : KB_ROOT,
      );
    }
    return source;
  }

  for (const root of byParent.get(null) ?? []) {
    buildNode(root);
  }
  for (const input of inputs) {
    if (!built.has(input.sourceId)) {
      buildNode({ ...input, parentSourceId: null });
    }
  }

  return ordered;
}

export function parseVirtualPath(
  path: string,
  sources: readonly VirtualFsSource[],
): VirtualPathTarget {
  const normalized = normalizeVirtualPath(path);
  if (normalized === "/") {
    return { kind: "root" };
  }
  if (normalized === KB_ROOT) {
    return { kind: "kbRoot" };
  }

  const orderedSources = [...sources].sort(
    (a, b) => b.dirPath.length - a.dirPath.length,
  );
  const source = orderedSources.find(
    (candidate) =>
      (candidate.filePath !== null && normalized === candidate.filePath) ||
      normalized === candidate.dirPath ||
      (candidate.readmePath !== null && normalized === candidate.readmePath) ||
      normalized === `${candidate.dirPath}/chunks` ||
      normalized.startsWith(`${candidate.dirPath}/chunks/`),
  );

  if (!source) {
    throw new Error(`ENOENT: no such file or directory, '${normalized}'`);
  }

  if (source.filePath !== null && normalized === source.filePath) {
    return { kind: "sourceFile", sourceId: source.sourceId };
  }
  if (source.readmePath !== null && normalized === source.readmePath) {
    return { kind: "libraryDirectoryReadme", sourceId: source.sourceId };
  }
  if (normalized === source.dirPath) {
    if (source.sourceType === "directory") {
      return { kind: "libraryDirectory", sourceId: source.sourceId };
    }
    throw new Error(`ENOENT: no such file or directory, '${normalized}'`);
  }
  if (normalized === `${source.dirPath}/chunks`) {
    return { kind: "sourceChunksDir", sourceId: source.sourceId };
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

export function findVirtualSource(
  sources: readonly VirtualFsSource[],
  sourceId: string,
) {
  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  if (!source) {
    throw new Error(`ENOENT: source '${sourceId}' is not visible in /kb`);
  }
  return source;
}
