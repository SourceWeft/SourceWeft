/**
 * Runner-agnostic fakes for the host services an agent tool consumes.
 *
 * Every builder returns a complete, well-typed service whose defaults take the
 * happy path (claims execute, blobs store, sandbox commands succeed), so a test
 * spreads in only the member it exercises. Nothing here imports a test runner:
 * the fakes are plain objects that vitest and node:test suites share alike.
 */
import type { ArtifactStorage } from "../artifact-storage";
import type {
  AgentToolOperationCacheServices,
  AgentToolSandboxServices,
  AgentToolWorkBlobServices,
} from "../agent-tools/host";
import { withAgentToolHostInvocationSignal } from "../agent-tools/timeout";

export function createFakeAgentToolOperationCache(
  overrides: Partial<AgentToolOperationCacheServices> = {},
): AgentToolOperationCacheServices {
  return {
    claimMany: async (input) => ({
      kind: "claimed",
      items: input.semanticKeys.map((semanticKey) => ({
        semanticKey,
        action: "execute",
        claimToken: "claim",
      })),
    }),
    complete: async () => ({ observationId: "observation" }),
    markUnknown: async () => undefined,
    ...overrides,
  };
}

export function createFakeAgentToolWorkBlobs(
  overrides: Partial<AgentToolWorkBlobServices> = {},
): AgentToolWorkBlobServices {
  return {
    putIfAbsent: async (input) => ({
      blobRef: "blob",
      contentDigest: input.contentDigest,
    }),
    getVerified: async () => null,
    getBySemanticKey: async () => null,
    deleteScope: async () => undefined,
    ...overrides,
  };
}

/**
 * Every member is present so the fake satisfies the trusted tools that demand
 * a `Required` sandbox before taking side effects.
 */
export function createFakeAgentToolSandbox(
  overrides: Partial<AgentToolSandboxServices> = {},
): Required<AgentToolSandboxServices> {
  return {
    allowedReadRoots: ["/workspace"],
    ensureCurrentSession: async () => ({ sessionGeneration: "session" }),
    uploadCurrentFiles: async () => undefined,
    listCurrentFiles: async () => [],
    downloadCurrentFile: async () => new Uint8Array(),
    executeCurrent: async () => ({ exitCode: 0, output: "" }),
    captureCurrentTree: async () => [],
    ...overrides,
  };
}

export function createFakeArtifactStorage(
  overrides: Partial<ArtifactStorage> = {},
): ArtifactStorage {
  return {
    buildArtifactStorageKey: ({ workspaceId, artifactId, fileName }) =>
      `workspaces/${workspaceId}/artifacts/${artifactId}/${fileName}`,
    getBucketName: () => "content",
    upload: async () => undefined,
    delete: async () => undefined,
    // Publishing only writes; the port requires a reader, and "nothing is
    // stored" is the honest answer for a fake that keeps no bytes.
    download: async () => null,
    ...overrides,
  };
}

/**
 * Attaches the trusted host cancellation signal to an invocation config the
 * way the runtime does, or leaves the config untouched when the test has no
 * signal to forward, so one call site serves both invocation shapes.
 */
export function agentToolInvocationConfig<
  Config extends Record<string, unknown>,
>(config: Config, signal?: AbortSignal): Config {
  return signal ? withAgentToolHostInvocationSignal(config, signal) : config;
}
