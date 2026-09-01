import { createHash } from "node:crypto";
import {
  AGENT_TOOL_HOST_LIMITS,
  type AgentToolWorkBlobServices,
} from "@sourceweft/contracts/agent-tools";
import {
  deleteArtifactObjectsByPrefix,
  downloadArtifactObjectWithMetadata,
  putArtifactObjectIfAbsent,
} from "../../../sources/storage";

const WORK_BLOB_VERSION = "v1";
const WORK_BLOB_PREFIX = `agent-wip/${WORK_BLOB_VERSION}`;
const WORK_BLOB_REF_PATTERN = /^wip1_([a-f0-9]{64})_([a-f0-9]{64})$/u;
const SHA256_DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const MAX_SCOPE_PART_CHARS = 256;
const MAX_SEMANTIC_KEY_CHARS = 1_024;
const MAX_CONTENT_TYPE_CHARS = 255;
const DIGEST_METADATA_KEY = "sourceweft-sha256";
const EXPIRES_METADATA_KEY = "sourceweft-expires-at";
const SCOPE_METADATA_KEY = "sourceweft-scope";
const SEMANTIC_METADATA_KEY = "sourceweft-semantic";

export type RunScopedWorkBlobScope = {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly runId: string;
};

type WorkBlobObjectStore = {
  putIfAbsent: typeof putArtifactObjectIfAbsent;
  download: typeof downloadArtifactObjectWithMetadata;
  deletePrefix: typeof deleteArtifactObjectsByPrefix;
};

export class WorkBlobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkBlobError";
    this.code = code;
  }
}

function sha256Hex(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function requireScopePart(name: string, value: string) {
  if (
    !value ||
    value !== value.trim() ||
    value.length > MAX_SCOPE_PART_CHARS ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new WorkBlobError(
      "WORK_BLOB_SCOPE_INVALID",
      `${name} is not a valid work-blob scope identity`,
    );
  }
  return value;
}

function requireSemanticKey(value: string) {
  if (
    !value ||
    value !== value.trim() ||
    value.length > MAX_SEMANTIC_KEY_CHARS ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new WorkBlobError(
      "WORK_BLOB_SEMANTIC_KEY_INVALID",
      "semanticKey is not valid",
    );
  }
  return value;
}

function requireContentType(value: string) {
  if (
    !value ||
    value !== value.trim() ||
    value.length > MAX_CONTENT_TYPE_CHARS ||
    /[\r\n\0]/u.test(value) ||
    !value.includes("/")
  ) {
    throw new WorkBlobError(
      "WORK_BLOB_CONTENT_TYPE_INVALID",
      "contentType is not valid",
    );
  }
  return value;
}

function requireDigest(value: string) {
  const match = SHA256_DIGEST_PATTERN.exec(value);
  if (!match) {
    throw new WorkBlobError(
      "WORK_BLOB_DIGEST_INVALID",
      "contentDigest must be a canonical sha256 digest",
    );
  }
  return value;
}

function digestBytes(bytes: Uint8Array) {
  return `sha256:${sha256Hex(bytes)}`;
}

function normalizeMetadata(metadata: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function scopeDigest(scope: RunScopedWorkBlobScope) {
  return sha256Hex(
    [scope.teamId, scope.workspaceId, scope.runId]
      .map((part) => `${part.length}:${part}`)
      .join("\0"),
  );
}

function coordinates(input: { scopeHash: string; semanticKey: string }) {
  const semanticHash = sha256Hex(requireSemanticKey(input.semanticKey));
  return {
    blobRef: `wip1_${input.scopeHash}_${semanticHash}`,
    key: `${WORK_BLOB_PREFIX}/${input.scopeHash}/${semanticHash}`,
    semanticHash,
  };
}

function coordinatesFromRef(input: { blobRef: string; scopeHash: string }) {
  const match = WORK_BLOB_REF_PATTERN.exec(input.blobRef);
  if (!match || match[1] !== input.scopeHash) {
    return null;
  }
  const semanticHash = match[2]!;
  return {
    blobRef: input.blobRef,
    key: `${WORK_BLOB_PREFIX}/${input.scopeHash}/${semanticHash}`,
    semanticHash,
  };
}

function requireBytes(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array)) {
    throw new WorkBlobError(
      "WORK_BLOB_BYTES_INVALID",
      "bytes must be a Uint8Array",
    );
  }
  if (bytes.byteLength > AGENT_TOOL_HOST_LIMITS.workBlobMaxBytes) {
    throw new WorkBlobError(
      "WORK_BLOB_TOO_LARGE",
      `Work blob exceeds the ${AGENT_TOOL_HOST_LIMITS.workBlobMaxBytes} byte limit`,
    );
  }
}

function requireTtlSeconds(ttlSeconds: number) {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > AGENT_TOOL_HOST_LIMITS.workBlobMaxTtlSeconds
  ) {
    throw new WorkBlobError(
      "WORK_BLOB_TTL_INVALID",
      `ttlSeconds must be between 1 and ${AGENT_TOOL_HOST_LIMITS.workBlobMaxTtlSeconds}`,
    );
  }
}

export function createRunScopedWorkBlobService(
  scopeInput: RunScopedWorkBlobScope,
  dependencies: {
    readonly now?: () => Date;
    readonly store?: WorkBlobObjectStore;
  } = {},
): AgentToolWorkBlobServices {
  const scope = {
    teamId: requireScopePart("teamId", scopeInput.teamId),
    workspaceId: requireScopePart("workspaceId", scopeInput.workspaceId),
    runId: requireScopePart("runId", scopeInput.runId),
  };
  const currentScopeHash = scopeDigest(scope);
  const prefix = `${WORK_BLOB_PREFIX}/${currentScopeHash}/`;
  const now = dependencies.now ?? (() => new Date());
  const store = dependencies.store ?? {
    putIfAbsent: putArtifactObjectIfAbsent,
    download: downloadArtifactObjectWithMetadata,
    deletePrefix: deleteArtifactObjectsByPrefix,
  };

  const read = async (input: {
    blobRef: string;
    expectedDigest?: string;
    expectedContentType?: string;
    key: string;
    semanticHash: string;
  }) => {
    const stored = await store.download({
      key: input.key,
      maxBytes: AGENT_TOOL_HOST_LIMITS.workBlobMaxBytes,
    });
    if (!stored) {
      return null;
    }
    const metadata = normalizeMetadata(stored.metadata);
    if (
      metadata[SCOPE_METADATA_KEY] !== currentScopeHash ||
      metadata[SEMANTIC_METADATA_KEY] !== input.semanticHash
    ) {
      throw new WorkBlobError(
        "WORK_BLOB_SCOPE_MISMATCH",
        "Stored work blob does not belong to the current run scope",
      );
    }
    const storedDigest = metadata[DIGEST_METADATA_KEY];
    if (!storedDigest || !SHA256_DIGEST_PATTERN.test(storedDigest)) {
      throw new WorkBlobError(
        "WORK_BLOB_INTEGRITY_FAILED",
        "Stored work blob is missing its canonical digest",
      );
    }
    const actualDigest = digestBytes(stored.body);
    if (
      actualDigest !== storedDigest ||
      (input.expectedDigest && input.expectedDigest !== storedDigest)
    ) {
      throw new WorkBlobError(
        "WORK_BLOB_INTEGRITY_FAILED",
        "Stored work blob digest verification failed",
      );
    }
    if (
      input.expectedContentType &&
      input.expectedContentType !== stored.contentType
    ) {
      throw new WorkBlobError(
        "WORK_BLOB_CONFLICT",
        "Stored work blob content type differs from the claimed value",
      );
    }
    const expiresAt = metadata[EXPIRES_METADATA_KEY];
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAtMs)) {
      throw new WorkBlobError(
        "WORK_BLOB_INTEGRITY_FAILED",
        "Stored work blob has invalid expiry metadata",
      );
    }
    if (expiresAtMs <= now().getTime()) {
      return null;
    }
    return {
      blobRef: input.blobRef,
      bytes: stored.body,
      contentType: stored.contentType,
      contentDigest: storedDigest,
    };
  };

  return {
    putIfAbsent: async (input) => {
      requireBytes(input.bytes);
      requireTtlSeconds(input.ttlSeconds);
      const contentType = requireContentType(input.contentType);
      const contentDigest = requireDigest(input.contentDigest);
      const actualDigest = digestBytes(input.bytes);
      if (actualDigest !== contentDigest) {
        throw new WorkBlobError(
          "WORK_BLOB_DIGEST_MISMATCH",
          "contentDigest does not match bytes",
        );
      }
      const object = coordinates({
        scopeHash: currentScopeHash,
        semanticKey: input.semanticKey,
      });
      const expiresAt = new Date(
        now().getTime() + input.ttlSeconds * 1_000,
      ).toISOString();
      const result = await store.putIfAbsent({
        key: object.key,
        body: input.bytes,
        contentType,
        metadata: {
          [DIGEST_METADATA_KEY]: contentDigest,
          [EXPIRES_METADATA_KEY]: expiresAt,
          [SCOPE_METADATA_KEY]: currentScopeHash,
          [SEMANTIC_METADATA_KEY]: object.semanticHash,
        },
      });
      if (result === "exists") {
        const existing = await read({
          ...object,
          expectedDigest: contentDigest,
          expectedContentType: contentType,
        });
        if (!existing) {
          throw new WorkBlobError(
            "WORK_BLOB_EXISTING_OBJECT_UNAVAILABLE",
            "Existing work blob is missing or expired",
          );
        }
      }
      return { blobRef: object.blobRef, contentDigest };
    },

    getVerified: async (input) => {
      const contentDigest = requireDigest(input.contentDigest);
      const object = coordinatesFromRef({
        blobRef: input.blobRef,
        scopeHash: currentScopeHash,
      });
      if (!object) {
        return null;
      }
      const result = await read({ ...object, expectedDigest: contentDigest });
      return result
        ? { bytes: result.bytes, contentType: result.contentType }
        : null;
    },

    getBySemanticKey: async (input) => {
      const object = coordinates({
        scopeHash: currentScopeHash,
        semanticKey: input.semanticKey,
      });
      return read(object);
    },

    deleteScope: () => store.deletePrefix({ prefix }),
  };
}
