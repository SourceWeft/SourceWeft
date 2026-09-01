import { Buffer } from "node:buffer";
import type {
  AgentToolFilesystemServices,
  AgentToolSandboxServices,
} from "@sourceweft/contracts/agent-tools";
import {
  ArtifactPublishError,
  type ArtifactSource,
  type PublishArtifactInput,
} from "./schemas";

export type ArtifactSourceBytes = {
  readonly bytes: Buffer;
  readonly mimeType?: string;
  readonly path: string;
  readonly source: ArtifactSource;
};

/**
 * Where the bytes come from, as the host lends them: a sandbox file or a
 * mounted agent filesystem. Both ports are declared in the shared contract, so
 * what this adapter reads and what the host passes are one declaration.
 */
export type ArtifactSourceServices = {
  readonly sandbox?: AgentToolSandboxServices;
  readonly filesystem?: AgentToolFilesystemServices;
};

export type ArtifactSourceAdapter = {
  readonly kind: ArtifactSource["kind"];
  readonly read: (input: {
    readonly publishInput: PublishArtifactInput;
    readonly services: ArtifactSourceServices;
    readonly signal?: AbortSignal;
  }) => Promise<ArtifactSourceBytes>;
};

function throwArtifactSourceAbortReason(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("Artifact source reading was aborted.", "AbortError")
  );
}

function messageFromUnknown(error: unknown) {
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toBuffer(content: string | readonly string[] | Uint8Array | Buffer) {
  if (Buffer.isBuffer(content)) {
    return content;
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (Array.isArray(content)) {
    return Buffer.from(content.join("\n"));
  }
  return Buffer.from(String(content));
}

function normalizeSandboxPath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const withoutTrailingSlash = absolute.replace(/\/$/gu, "");
  return withoutTrailingSlash || "/";
}

function isRootOrChild(path: string, root: string) {
  const normalizedRoot = normalizeSandboxPath(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function formatAllowedRoots(roots: readonly string[]) {
  return roots.map(normalizeSandboxPath).join(", ");
}

function assertSandboxSourcePath(input: {
  value: string;
  allowedRoots?: readonly string[];
}) {
  const path = normalizeSandboxPath(input.value);
  const allowedRoots =
    input.allowedRoots && input.allowedRoots.length > 0
      ? input.allowedRoots
      : ["/workspace"];
  if (
    /[\x00-\x1f\x7f]/u.test(path) ||
    path.includes("..") ||
    path.includes("~") ||
    !allowedRoots.some((root) => isRootOrChild(path, root))
  ) {
    throw new ArtifactPublishError(
      "ARTIFACT_SOURCE_INVALID",
      `sandbox_path source.path must be under allowed sandbox roots: ${formatAllowedRoots(allowedRoots)}`,
    );
  }
  return path;
}

function normalizeWorkFilePath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const withoutTrailingSlash = absolute.replace(/\/$/gu, "");
  return withoutTrailingSlash || "/";
}

function assertWorkFileSourcePath(value: string) {
  const path = normalizeWorkFilePath(value);
  if (
    /[\x00-\x1f\x7f]/u.test(path) ||
    path.includes("..") ||
    path.includes("~") ||
    (path !== "/workfiles" && !path.startsWith("/workfiles/"))
  ) {
    throw new ArtifactPublishError(
      "ARTIFACT_SOURCE_INVALID",
      "work_file source.path must be under /workfiles.",
    );
  }
  return path;
}

const sandboxPathAdapter: ArtifactSourceAdapter = {
  kind: "sandbox_path",
  async read(input) {
    throwArtifactSourceAbortReason(input.signal);
    const source = input.publishInput.source;
    if (source.kind !== "sandbox_path") {
      throw new ArtifactPublishError(
        "ARTIFACT_SOURCE_INVALID",
        `sandbox_path adapter cannot read source kind ${source.kind}`,
      );
    }
    const sandboxPath = assertSandboxSourcePath({
      value: source.path,
      allowedRoots: input.services.sandbox?.allowedReadRoots,
    });
    const download = input.services.sandbox?.downloadCurrentFile;
    if (!download) {
      throw new ArtifactPublishError(
        "SANDBOX_UNAVAILABLE",
        "sandbox download service is not available",
      );
    }

    try {
      const bytes = await download({
        sandboxPath,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      throwArtifactSourceAbortReason(input.signal);
      return {
        bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
        path: sandboxPath,
        source,
      };
    } catch (error) {
      throwArtifactSourceAbortReason(input.signal);
      throw new ArtifactPublishError(
        "ARTIFACT_SOURCE_NOT_FOUND",
        `sandbox download failed for ${sandboxPath}: ${messageFromUnknown(error)}`,
      );
    }
  },
};

const workFileAdapter: ArtifactSourceAdapter = {
  kind: "work_file",
  async read(input) {
    throwArtifactSourceAbortReason(input.signal);
    const source = input.publishInput.source;
    if (source.kind !== "work_file") {
      throw new ArtifactPublishError(
        "ARTIFACT_SOURCE_INVALID",
        `work_file adapter cannot read source kind ${source.kind}`,
      );
    }

    const workFilePath = assertWorkFileSourcePath(source.path);
    const filesystem = input.services.filesystem;
    if (!filesystem?.readRaw && !filesystem?.downloadFiles) {
      throw new ArtifactPublishError(
        "ARTIFACT_SOURCE_UNAVAILABLE",
        "work_file read service is not available",
      );
    }

    if (filesystem.downloadFiles) {
      const [result] = await filesystem.downloadFiles([workFilePath]);
      throwArtifactSourceAbortReason(input.signal);
      if (result?.content) {
        return {
          bytes: Buffer.isBuffer(result.content)
            ? result.content
            : Buffer.from(result.content),
          path: workFilePath,
          source: {
            ...source,
            path: workFilePath,
          },
        };
      }
      if (result?.error) {
        throw new ArtifactPublishError(
          "ARTIFACT_SOURCE_NOT_FOUND",
          `work_file download failed for ${workFilePath}: ${messageFromUnknown(result.error)}`,
        );
      }
    }

    const raw = await filesystem.readRaw?.(workFilePath);
    throwArtifactSourceAbortReason(input.signal);
    if (!raw?.data) {
      throw new ArtifactPublishError(
        "ARTIFACT_SOURCE_NOT_FOUND",
        `work_file read failed for ${workFilePath}: ${messageFromUnknown(raw?.error ?? "file not found")}`,
      );
    }

    return {
      bytes: toBuffer(raw.data.content),
      mimeType: raw.data.mimeType,
      path: workFilePath,
      source: {
        ...source,
        path: workFilePath,
      },
    };
  },
};

export const artifactSourceAdapters = [
  sandboxPathAdapter,
  workFileAdapter,
] as const;

export function adapterForSource(
  source: ArtifactSource,
  adapters: readonly ArtifactSourceAdapter[] = artifactSourceAdapters,
) {
  return adapters.find((adapter) => adapter.kind === source.kind) ?? null;
}
