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

type MountedBackend = {
  capability: AgentFilesystemMountCapability;
  backend: BackendProtocolV2;
};

function rootInfo(path: string) {
  return { path: `${path}/`, is_dir: true, size: 0 };
}

function isMountPath(path: string | null | undefined, mount: string) {
  const value = path || "";
  return value === mount || value.startsWith(`${mount}/`);
}

function stripMount(path: string, mount: string) {
  if (path === mount) {
    return "/";
  }
  const suffix = path.slice(mount.length);
  return suffix.startsWith("/") ? suffix : `/${suffix}`;
}

function prefixMount(path: string, mount: string) {
  return `${mount}${path === "/" ? "/" : path}`.replace(/\/+/g, "/");
}

export class MountedAgentFilesystemBackend implements BackendProtocolV2 {
  private readonly mounts: MountedBackend[];
  private readonly defaultMount: MountedBackend;
  private readonly writableMounts: MountedBackend[];

  constructor(
    input: {
      knowledge: BackendProtocolV2;
      working: BackendProtocolV2;
      skills?: BackendProtocolV2 | null;
      mounts?: AgentFilesystemMountCapability[];
    },
  ) {
    const capabilities =
      input.mounts ??
      createDefaultFilesystemMounts({ skillsEnabled: Boolean(input.skills) });
    const knowledgeCapability = capabilities.find((mount) => mount.root === KNOWLEDGE_MOUNT.root) ?? KNOWLEDGE_MOUNT;
    const workingCapability = capabilities.find((mount) => mount.root === WORK_MOUNT.root) ?? WORK_MOUNT;
    const skillsCapability = capabilities.find((mount) => mount.root === SKILLS_MOUNT.root) ?? SKILLS_MOUNT;
    this.mounts = [
      { capability: knowledgeCapability, backend: input.knowledge },
      { capability: workingCapability, backend: input.working },
      ...(input.skills ? [{ capability: skillsCapability, backend: input.skills }] : []),
    ];
    this.defaultMount =
      this.mounts.find((mount) => mount.capability.evidenceRole === "source_evidence") ??
      this.mounts[0]!;
    this.writableMounts = this.mounts.filter((mount) => mount.capability.writable);
  }

  private route(path: string | null | undefined) {
    const value = path || this.defaultMount.capability.root;
    return this.mounts.find((mount) => isMountPath(value, mount.capability.root)) ?? this.defaultMount;
  }

  private writableRoute(path: string) {
    return this.writableMounts.find((mount) => isMountPath(path, mount.capability.root));
  }

  async ls(path = "/"): Promise<LsResult> {
    if (path === "/") {
      return {
        files: this.mounts
          .map((mount) => rootInfo(mount.capability.root))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
    }
    const mount = this.route(path);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      const result = await mount.backend.ls(stripMount(path, mount.capability.root));
      if (result.error) return result;
      return {
        files: (result.files ?? []).map((file) => ({
          ...file,
          path: prefixMount(file.path, mount.capability.root),
        })),
      };
    }
    return mount.backend.ls(path);
  }

  async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    const mount = this.route(filePath);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      return mount.backend.read(stripMount(filePath, mount.capability.root), offset, limit);
    }
    return mount.backend.read(filePath, offset, limit);
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const mount = this.route(filePath);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      return mount.backend.readRaw(stripMount(filePath, mount.capability.root));
    }
    return mount.backend.readRaw(filePath);
  }

  async grep(
    pattern: string,
    path: string | null = KNOWLEDGE_MOUNT.root,
    glob?: string | null,
  ): Promise<GrepResult> {
    if (path === "/") {
      return this.defaultMount.backend.grep(pattern, this.defaultMount.capability.root, glob);
    }
    const mount = this.route(path);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      const result = await mount.backend.grep(
        pattern,
        stripMount(path ?? mount.capability.root, mount.capability.root),
        glob,
      );
      if (result.error) return result;
      return {
        matches: (result.matches ?? []).map((match) => ({
          ...match,
          path: prefixMount(match.path, mount.capability.root),
        })),
      };
    }
    return mount.backend.grep(pattern, path, glob);
  }

  async glob(pattern: string, path = "/"): Promise<GlobResult> {
    if (path === "/") {
      const patternMount = this.route(pattern);
      if (isMountPath(pattern, patternMount.capability.root)) {
        if (patternMount.capability.root === SKILLS_MOUNT.root) {
          const result = await patternMount.backend.glob(
            stripMount(pattern, patternMount.capability.root),
            "/",
          );
          if (result.error) return result;
          return {
            files: (result.files ?? []).map((file) => ({
              ...file,
              path: prefixMount(file.path, patternMount.capability.root),
            })),
          };
        }
        return patternMount.backend.glob(pattern, patternMount.capability.root);
      }
      return this.defaultMount.backend.glob(pattern, this.defaultMount.capability.root);
    }
    const mount = this.route(path);
    if (mount.capability.root === SKILLS_MOUNT.root) {
      const result = await mount.backend.glob(
        pattern,
        stripMount(path, mount.capability.root),
      );
      if (result.error) return result;
      return {
        files: (result.files ?? []).map((file) => ({
          ...file,
          path: prefixMount(file.path, mount.capability.root),
        })),
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
}
