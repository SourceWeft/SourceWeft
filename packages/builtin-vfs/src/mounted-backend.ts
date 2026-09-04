import type {
  BackendProtocolV2,
  EditResult,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";
import {
  createDefaultFilesystemMounts,
  KNOWLEDGE_MOUNT,
  SKILLS_MOUNT,
  WORK_MOUNT,
  type AgentFilesystemMountCapability,
} from "./filesystem-capabilities";
import {
  isMountPath,
  prefixMountedFiles,
  rootInfo,
  stripMount,
} from "./mounted-paths";
import { downloadMountedFiles, uploadMountedFiles } from "./mounted-transfer";
import type { MountedBackend } from "./mounted-types";

function applyGrepMaxCount(params: {
  result: GrepResult;
  maxCount?: number | null;
}): GrepResult {
  const { result, maxCount } = params;
  if (
    maxCount == null ||
    result.matches == null ||
    result.matches.length <= maxCount
  ) {
    return result;
  }

  return {
    error: result.error,
    matches: result.matches.slice(0, maxCount),
    truncated: true,
  };
}

/**
 * A mount backend that reports transport failures instead of throwing.
 *
 * Every result in this protocol carries an optional `error`, and every caller
 * checks it — that is how a missing file or a denied path is reported. A mount
 * backed by a remote service has a second failure mode the protocol never saw:
 * the service itself being unreachable. The skills mount reads through the
 * sandbox, so a provider hiccup ("sandbox provider container is not ready or
 * has no network address") threw straight out of `ls` / `read_file`.
 *
 * Those tools run in parallel, and the rejection surfaced inside LangGraph's
 * stream pump — a promise this side never holds — so it escaped as an
 * unhandledRejection and failed the whole turn. The model saw nothing it could
 * act on, even though the error says to retry. Reported as an `error` instead,
 * it becomes an ordinary tool result the model can read and route around.
 *
 * Wrapping at construction covers every method the protocol has, including the
 * ones added after this comment.
 */
function reportingFailures(backend: BackendProtocolV2): BackendProtocolV2 {
  return new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          return result instanceof Promise
            ? result.catch((error: unknown) => ({
                error: errorText(error),
              }))
            : result;
        } catch (error) {
          return { error: errorText(error) };
        }
      };
    },
  }) as BackendProtocolV2;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MountedAgentFilesystemBackend implements BackendProtocolV2 {
  private readonly mounts: MountedBackend[];
  private readonly defaultMount: MountedBackend;
  private readonly writableMounts: MountedBackend[];

  constructor(input: {
    knowledge: BackendProtocolV2;
    working: BackendProtocolV2;
    skills?: BackendProtocolV2 | null;
    mounts?: AgentFilesystemMountCapability[];
  }) {
    const capabilities =
      input.mounts ??
      createDefaultFilesystemMounts({ skillsEnabled: Boolean(input.skills) });
    const knowledgeCapability =
      capabilities.find((mount) => mount.root === KNOWLEDGE_MOUNT.root) ??
      KNOWLEDGE_MOUNT;
    const workingCapability =
      capabilities.find((mount) => mount.root === WORK_MOUNT.root) ??
      WORK_MOUNT;
    const skillsCapability =
      capabilities.find((mount) => mount.root === SKILLS_MOUNT.root) ??
      SKILLS_MOUNT;
    this.mounts = [
      {
        capability: knowledgeCapability,
        backend: reportingFailures(input.knowledge),
      },
      {
        capability: workingCapability,
        backend: reportingFailures(input.working),
      },
      ...(input.skills
        ? [
            {
              capability: skillsCapability,
              backend: reportingFailures(input.skills),
            },
          ]
        : []),
    ];
    this.defaultMount =
      this.mounts.find(
        (mount) => mount.capability.evidenceRole === "source_evidence",
      ) ?? this.mounts[0]!;
    this.writableMounts = this.mounts.filter(
      (mount) => mount.capability.writable,
    );
  }

  private route(path: string | null | undefined) {
    const value = path || this.defaultMount.capability.root;
    return (
      this.mounts.find((mount) => isMountPath(value, mount.capability.root)) ??
      null
    );
  }

  private defaultRoute() {
    return this.defaultMount;
  }

  private routeOrDefault(path: string | null | undefined) {
    return this.route(path) ?? this.defaultMount;
  }

  private writableRoute(path: string) {
    return this.writableMounts.find((mount) =>
      isMountPath(path, mount.capability.root),
    );
  }

  async ls(path = "/"): Promise<LsResult> {
    if (path === "/") {
      return {
        files: this.mounts
          .map((mount) => rootInfo(mount.capability.root))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
    }
    const mount = this.routeOrDefault(path);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      const result = await mount.backend.ls(
        stripMount(path, mount.capability.root),
      );
      if (result.error) return result;
      return {
        files: prefixMountedFiles(result.files, mount.capability.root),
      };
    }
    return mount.backend.ls(path);
  }

  async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const mount = this.routeOrDefault(filePath);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      return mount.backend.read(
        stripMount(filePath, mount.capability.root),
        offset,
        limit,
      );
    }
    return mount.backend.read(filePath, offset, limit);
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const mount = this.routeOrDefault(filePath);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      return mount.backend.readRaw(stripMount(filePath, mount.capability.root));
    }
    return mount.backend.readRaw(filePath);
  }

  async grep(
    pattern: string,
    path: string | null = KNOWLEDGE_MOUNT.root,
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    if (path === "/") {
      return this.defaultMount.backend.grep(
        pattern,
        this.defaultMount.capability.root,
        glob,
        maxCount,
      );
    }
    const mount = this.routeOrDefault(path);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      const result = await mount.backend.grep(
        pattern,
        stripMount(path ?? mount.capability.root, mount.capability.root),
        glob,
        maxCount,
      );
      if (result.error) return result;
      return {
        matches: (result.matches ?? []).map((match) => ({
          ...match,
          path: `${mount.capability.root}${match.path === "/" ? "/" : match.path}`.replace(
            /\/+/g,
            "/",
          ),
        })),
        truncated: result.truncated,
      };
    }
    return applyGrepMaxCount({
      result: await mount.backend.grep(pattern, path, glob, maxCount),
      maxCount,
    });
  }

  async glob(pattern: string, path = "/"): Promise<GlobResult> {
    if (path === "/") {
      const patternMount = this.route(pattern) ?? this.defaultRoute();
      if (isMountPath(pattern, patternMount.capability.root)) {
        if (patternMount.capability.root === SKILLS_MOUNT.root) {
          const result = await patternMount.backend.glob(
            stripMount(pattern, patternMount.capability.root),
            "/",
          );
          if (result.error) return result;
          return {
            files: prefixMountedFiles(
              result.files,
              patternMount.capability.root,
            ),
            truncated: result.truncated,
          };
        }
        return patternMount.backend.glob(pattern, patternMount.capability.root);
      }
      return this.defaultMount.backend.glob(
        pattern,
        this.defaultMount.capability.root,
      );
    }
    const mount = this.routeOrDefault(path);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      const result = await mount.backend.glob(
        pattern,
        stripMount(path, mount.capability.root),
      );
      if (result.error) return result;
      return {
        files: prefixMountedFiles(result.files, mount.capability.root),
        truncated: result.truncated,
      };
    }
    return mount.backend.glob(pattern, path);
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const mount = this.writableRoute(filePath);
    if (!mount) {
      return {
        error: `EROFS: only ${this.writableMounts.map((item) => item.capability.root).join(", ") || "no mounted filesystem"} is writable, write '${filePath}' is not allowed`,
      };
    }
    return mount.backend.write(filePath, content);
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const mount = this.writableRoute(filePath);
    if (!mount) {
      return {
        error: `EROFS: only ${this.writableMounts.map((item) => item.capability.root).join(", ") || "no mounted filesystem"} is writable, edit '${filePath}' is not allowed`,
      };
    }
    return mount.backend.edit(filePath, oldString, newString, replaceAll);
  }

  async downloadFiles(paths: string[]) {
    return downloadMountedFiles({
      paths,
      mounts: this.mounts,
      route: (path) => this.route(path),
    });
  }

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    return uploadMountedFiles({
      files,
      writableRoute: (path) => this.writableRoute(path),
    });
  }
}
