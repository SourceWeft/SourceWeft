import type {
  BackendProtocolV2,
  EditResult,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";

function normalizePrefix(prefix: string) {
  const normalized = prefix.replace(/\\/g, "/").replace(/\/+/g, "/");
  const withLeading = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  return withLeading.replace(/\/+$/g, "") || "/";
}

function normalizePath(path: string | null | undefined) {
  const raw = path?.trim() || "/";
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
  const withLeading = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  return withLeading.replace(/\/+$/g, "") || "/";
}

function stripPrefix(path: string, prefix: string) {
  const normalized = normalizePath(path);
  if (normalized === prefix) {
    return "/";
  }
  if (normalized.startsWith(`${prefix}/`)) {
    return normalized.slice(prefix.length) || "/";
  }
  return normalized;
}

export class PrefixedBackendAdapter implements BackendProtocolV2 {
  private readonly prefix: string;

  constructor(
    prefix: string,
    private readonly backend: BackendProtocolV2,
  ) {
    this.prefix = normalizePrefix(prefix);
  }

  private toInner(path: string | null | undefined) {
    const normalized = normalizePath(path);
    return normalized === "/" ? this.prefix : `${this.prefix}${normalized}`;
  }

  private fromInner(path: string) {
    return stripPrefix(path, this.prefix);
  }

  private fileInfo(file: FileInfo): FileInfo {
    const path = this.fromInner(file.path);
    return {
      ...file,
      path:
        file.is_dir && path !== "/" && !path.endsWith("/") ? `${path}/` : path,
    };
  }

  private grepMatch(match: GrepMatch): GrepMatch {
    return {
      ...match,
      path: this.fromInner(match.path),
    };
  }

  async ls(path = "/"): Promise<LsResult> {
    const result = await this.backend.ls(this.toInner(path));
    if (result.error) {
      return result;
    }
    return {
      files: (result.files ?? []).map((file) => this.fileInfo(file)),
    };
  }

  read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> | ReadResult {
    return this.backend.read(this.toInner(filePath), offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> | ReadRawResult {
    return this.backend.readRaw(this.toInner(filePath));
  }

  async grep(
    pattern: string,
    path: string | null = "/",
    glob?: string | null,
  ): Promise<GrepResult> {
    const result = await this.backend.grep(pattern, this.toInner(path), glob);
    if (result.error) {
      return result;
    }
    return {
      matches: (result.matches ?? []).map((match) => this.grepMatch(match)),
    };
  }

  async glob(pattern: string, path = "/"): Promise<GlobResult> {
    const routedPattern = pattern.startsWith("/")
      ? this.toInner(pattern)
      : pattern;
    const result = await this.backend.glob(routedPattern, this.toInner(path));
    if (result.error) {
      return result;
    }
    return {
      files: (result.files ?? []).map((file) => this.fileInfo(file)),
    };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const result = await this.backend.write(this.toInner(filePath), content);
    return result.error
      ? result
      : { ...result, path: this.fromInner(result.path) };
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const result = await this.backend.edit(
      this.toInner(filePath),
      oldString,
      newString,
      replaceAll,
    );
    return result.error
      ? result
      : { ...result, path: this.fromInner(result.path) };
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    if (!this.backend.downloadFiles) {
      throw new Error("Backend does not support downloadFiles");
    }
    const result = await this.backend.downloadFiles(
      paths.map((path) => this.toInner(path)),
    );
    return result.map((item, index) => ({
      ...item,
      path: paths[index] ?? this.fromInner(item.path),
    }));
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    if (!this.backend.uploadFiles) {
      throw new Error("Backend does not support uploadFiles");
    }
    const result = await this.backend.uploadFiles(
      files.map(([path, content]) => [this.toInner(path), content]),
    );
    return result.map((item, index) => ({
      ...item,
      path: files[index]?.[0] ?? this.fromInner(item.path),
    }));
  }
}
