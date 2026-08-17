import type {
  BackendProtocolV2,
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";
import { applyGrepMaxCount } from "deepagents";
import type { EnabledSkillDescriptor } from "./types";
import { sanitizeNonCitableCitationMarkers } from "../threads/agent/fs-utils";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";

type SkillFileEntry = {
  path: string;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  modifiedAt: string;
};

function normalizePath(value: string | null | undefined) {
  const raw = value?.trim() || "/";
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
  const withLeading = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  return withLeading.length > 1 ? withLeading.replace(/\/$/g, "") : "/";
}

function lineNumberContent(content: string) {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

function simpleGlobToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "::DOUBLE_STAR_SLASH::")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/::DOUBLE_STAR_SLASH::/g, "(?:.*/)?")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function compileGrepRegex(pattern: string) {
  const normalized = pattern.trim().replace(/^\(\?i\)/, "");
  if (!normalized) {
    return "grep pattern must not be empty";
  }
  try {
    return new RegExp(normalized, "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid regex pattern '${pattern}': ${message}`;
  }
}

export class SelectedSkillsBackend implements BackendProtocolV2 {
  private readonly skillNames: string[];
  private readonly filesByPath = new Map<string, SkillFileEntry>();
  private readonly directoryPaths = new Set<string>(["/"]);

  constructor(skills: EnabledSkillDescriptor[]) {
    const now = new Date().toISOString();
    this.skillNames = skills
      .map((skill) => skill.name)
      .sort((a, b) => a.localeCompare(b));
    for (const skill of skills) {
      this.directoryPaths.add(`/${skill.name}`);
      this.directoryPaths.add(`/${skill.name}/`);
      for (const file of skill.files) {
        const fullPath = normalizePath(`/${skill.name}/${file.path}`);
        this.filesByPath.set(fullPath, {
          path: fullPath,
          contentText: file.contentText,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          contentHash: file.contentHash,
          modifiedAt: now,
        });

        const segments = fullPath.split("/").filter(Boolean);
        for (let index = 1; index < segments.length; index += 1) {
          this.directoryPaths.add(`/${segments.slice(0, index).join("/")}`);
          this.directoryPaths.add(`/${segments.slice(0, index).join("/")}/`);
        }
      }
    }
  }

  private listDirectory(path: string): FileInfo[] {
    const normalized = normalizePath(path);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entries = new Map<string, FileInfo>();

    for (const name of this.skillNames) {
      const skillPath = `/${name}/`;
      if (normalized === "/") {
        entries.set(skillPath, { path: skillPath, is_dir: true });
      }
    }

    for (const dir of this.directoryPaths) {
      const dirPath = dir.endsWith("/") ? dir : `${dir}/`;
      if (
        dirPath === "/" ||
        !dirPath.startsWith(prefix) ||
        dirPath === prefix
      ) {
        continue;
      }
      const rest = dirPath.slice(prefix.length);
      if (!rest) {
        continue;
      }
      const segment = rest.split("/").filter(Boolean)[0];
      if (!segment) {
        continue;
      }
      entries.set(`${prefix}${segment}/`, {
        path: `${prefix}${segment}/`,
        is_dir: true,
      });
    }

    for (const file of this.filesByPath.values()) {
      if (!file.path.startsWith(prefix)) {
        continue;
      }
      const rest = file.path.slice(prefix.length);
      if (!rest || rest.includes("/")) {
        continue;
      }
      entries.set(file.path, {
        path: file.path,
        is_dir: false,
        size: file.sizeBytes,
        modified_at: file.modifiedAt,
      });
    }

    return Array.from(entries.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }

  async ls(path: string): Promise<LsResult> {
    const normalized = normalizePath(path);
    if (
      !this.directoryPaths.has(normalized) &&
      !this.directoryPaths.has(`${normalized}/`)
    ) {
      if (this.filesByPath.has(normalized)) {
        return { error: `ENOTDIR: not a directory, ls '${normalized}'` };
      }
      return { error: `ENOENT: no such directory, ls '${normalized}'` };
    }
    return { files: this.listDirectory(normalized) };
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    const normalized = normalizePath(filePath);
    const file = this.filesByPath.get(normalized);
    if (!file) {
      if (
        this.directoryPaths.has(normalized) ||
        this.directoryPaths.has(`${normalized}/`)
      ) {
        return {
          error: `EISDIR: is a directory, ${AGENT_TOOL_NAMES.readFile} '${normalized}'`,
        };
      }
      return {
        error: `ENOENT: no such file, ${AGENT_TOOL_NAMES.readFile} '${normalized}'`,
      };
    }

    if (normalized.endsWith("/SKILL.md")) {
      return {
        mimeType: file.mimeType,
        content: sanitizeNonCitableCitationMarkers(file.contentText),
      };
    }

    const safeContent = sanitizeNonCitableCitationMarkers(file.contentText);
    const lines = safeContent.split(/\r?\n/);
    const boundedOffset = Math.max(0, offset);
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const selected = lines.slice(boundedOffset, boundedOffset + boundedLimit);
    const more =
      boundedOffset + selected.length < lines.length
        ? `\n\nOutput truncated. Continue with ${AGENT_TOOL_NAMES.readFile}(path: "${normalized}", offset: ${boundedOffset + selected.length}, limit: ${boundedLimit}).`
        : "";
    return {
      mimeType: file.mimeType,
      content: [
        `Path: ${normalized}`,
        "Skill content is workflow instruction material, not citable source evidence.",
        "",
        lineNumberContent(selected.join("\n")),
        more,
      ].join("\n"),
    };
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const normalized = normalizePath(filePath);
    const file = this.filesByPath.get(normalized);
    if (!file) {
      return {
        error: `ENOENT: no such file, ${AGENT_TOOL_NAMES.readFile} '${normalized}'`,
      };
    }
    const data: FileData = {
      content: sanitizeNonCitableCitationMarkers(file.contentText),
      mimeType: file.mimeType,
      created_at: file.modifiedAt,
      modified_at: file.modifiedAt,
    };
    return { data };
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const encoder = new TextEncoder();
    return paths.map((filePath) => {
      const normalized = normalizePath(filePath);
      const file = this.filesByPath.get(normalized);
      if (file) {
        return {
          path: filePath,
          content: encoder.encode(
            sanitizeNonCitableCitationMarkers(file.contentText),
          ),
          error: null,
        };
      }
      if (
        this.directoryPaths.has(normalized) ||
        this.directoryPaths.has(`${normalized}/`)
      ) {
        return {
          path: filePath,
          content: null,
          error: "is_directory",
        };
      }
      return {
        path: filePath,
        content: null,
        error: "file_not_found",
      };
    });
  }

  async glob(pattern: string, path = "/"): Promise<GlobResult> {
    const base = normalizePath(path);
    const normalizedPattern = pattern.startsWith("/")
      ? normalizePath(pattern)
      : normalizePath(`${base}/${pattern}`);
    const matcher = simpleGlobToRegExp(normalizedPattern);
    const files = [
      ...Array.from(this.directoryPaths)
        .filter(
          (dir) =>
            dir !== "/" && matcher.test(dir.endsWith("/") ? dir : `${dir}/`),
        )
        .map((dir) => ({
          path: dir.endsWith("/") ? dir : `${dir}/`,
          is_dir: true,
        })),
      ...Array.from(this.filesByPath.values())
        .filter((file) => matcher.test(file.path))
        .map((file) => ({
          path: file.path,
          is_dir: false,
          size: file.sizeBytes,
          modified_at: file.modifiedAt,
        })),
    ].sort((a, b) => a.path.localeCompare(b.path));
    return { files };
  }

  async grep(
    pattern: string,
    path: string | null = "/",
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    const regex = compileGrepRegex(pattern);
    if (typeof regex === "string") {
      return { error: regex };
    }
    const base = normalizePath(path || "/");
    const globMatcher = glob
      ? simpleGlobToRegExp(
          glob.startsWith("/")
            ? normalizePath(glob)
            : normalizePath(`${base}/${glob}`),
        )
      : null;
    const matches: GrepMatch[] = [];
    for (const file of this.filesByPath.values()) {
      if (
        !file.path.startsWith(base === "/" ? "/" : `${base}/`) &&
        file.path !== base
      ) {
        continue;
      }
      if (globMatcher && !globMatcher.test(file.path)) {
        continue;
      }
      const lines = file.contentText.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (regex.test(line)) {
          matches.push({
            path: file.path,
            line: index + 1,
            text: sanitizeNonCitableCitationMarkers(line.trim()),
          });
          if (matches.length >= 50) {
            return applyGrepMaxCount({
              result: { matches, truncated: true },
              maxCount,
            });
          }
        }
      }
    }
    return applyGrepMaxCount({ result: { matches }, maxCount });
  }

  async write(filePath: string, _content: string): Promise<WriteResult> {
    return {
      error: `EROFS: /skills is a read-only skills filesystem, write '${filePath}' is not allowed`,
    };
  }

  async edit(
    filePath: string,
    _oldString: string,
    _newString: string,
    _replaceAll?: boolean,
  ): Promise<EditResult> {
    return {
      error: `EROFS: /skills is a read-only skills filesystem, edit '${filePath}' is not allowed`,
    };
  }
}
