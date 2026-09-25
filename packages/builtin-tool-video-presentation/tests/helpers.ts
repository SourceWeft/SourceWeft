import type {
  AgentToolArtifactVersionServices,
  AgentToolCurrentRunArtifactPublicationServices,
  AgentToolMediaServices,
  AgentToolModelGatewayService,
  AgentToolOperationCacheServices,
  AgentToolReceiptServices,
  AgentToolSandboxServices,
  AgentToolWorkBlobServices,
} from "@sourceweft/contracts/agent-tools";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import {
  createFakeAgentToolOperationCache,
  createFakeAgentToolSandbox,
  createFakeAgentToolWorkBlobs,
  createFakeArtifactStorage,
} from "@sourceweft/contracts/testing";
import type { ModelGateway } from "@sourceweft/model-gateway";

/** The union of every gateway surface a video tool binds. */
type VideoModelSurface = Pick<ModelGateway, "chat" | "images" | "tts">;

export type FakeVideoServices = {
  artifactVersions: AgentToolArtifactVersionServices;
  currentRunArtifacts: AgentToolCurrentRunArtifactPublicationServices;
  media: AgentToolMediaServices;
  modelGateway: AgentToolModelGatewayService<VideoModelSurface>;
  operationCache: AgentToolOperationCacheServices;
  receipts: AgentToolReceiptServices;
  sandbox: Required<AgentToolSandboxServices>;
  storage: ArtifactStorage;
  workBlobs: AgentToolWorkBlobServices;
};

export type FakeVideoServicesOverrides = {
  readonly [Group in keyof FakeVideoServices]?: Partial<
    FakeVideoServices[Group]
  >;
};

/**
 * Every host service a video tool can take, with happy-path defaults.
 *
 * Overrides merge one service group at a time, so a test replaces only the
 * member it observes (`operationCache.claimMany`, `sandbox.uploadCurrentFiles`)
 * and inherits the rest. The result is a superset of each tool's `services`
 * parameter; the model gateway default opens an empty client, so a test that
 * reaches a provider supplies its own `getClient`.
 */
export function createFakeVideoServices(
  overrides: FakeVideoServicesOverrides = {},
): FakeVideoServices {
  return {
    artifactVersions: {
      readAuthorizedCurrentVersion: async () => null,
      ...overrides.artifactVersions,
    },
    currentRunArtifacts: {
      allocateArtifactId: () => "artifact-1",
      cleanupPreallocatedArtifact: async () => undefined,
      publishCommitted: async () => ({ ok: false, reason: "run_inactive" }),
      ...overrides.currentRunArtifacts,
    },
    media: {
      probeAudioDurationSeconds: async () => null,
      ...overrides.media,
    },
    modelGateway: {
      getClient: async () => ({}) as never,
      ...overrides.modelGateway,
    },
    operationCache: createFakeAgentToolOperationCache(overrides.operationCache),
    receipts: {
      issueCurrentRunReceipt: async () => ({ receiptId: "receipt" }),
      resolveCurrentRunReceipt: async () => null,
      ...overrides.receipts,
    },
    sandbox: createFakeAgentToolSandbox(overrides.sandbox),
    storage: createFakeArtifactStorage(overrides.storage),
    workBlobs: createFakeAgentToolWorkBlobs(overrides.workBlobs),
  };
}
