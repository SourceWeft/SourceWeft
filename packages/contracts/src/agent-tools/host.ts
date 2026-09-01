/**
 * The host→capability contract for agent tools.
 *
 * When a turn binds tools, the host calls each capability's
 * `createCapabilityAgentTools({ manifest, toolIds, context, services })`. For a
 * long time `context` and `services` were `Record<string, unknown>` on the host
 * side and re-declared, guessed at, by hand inside every capability package.
 * Nothing checked the two halves against each other: a capability could ask for
 * `services.storage` after the host stopped passing it, and the only symptom
 * was a tool that silently failed to bind at runtime. These are the named
 * types both halves now import, so that mismatch is a compile error.
 *
 * Two rules keep this file honest:
 *
 *  1. Nothing here may name a capability. No tool names, artifact types, job
 *     names or model kinds owned by one capability — those are exactly the
 *     identity the host is not allowed to know. Every member below is a
 *     primitive the host can implement without knowing who calls it.
 *  2. Nothing capability-specific may be added to `AgentToolHostServices`. The
 *     bag is handed to *every* capability, so a field only one of them reads
 *     (a font base URL for a deck renderer, say) is configuration that belongs
 *     in that capability's own manifest/config, not here. The host annotates
 *     its builder with this type, so excess-property checking rejects the
 *     addition at the point someone tries it.
 *
 * Shapes owned by the gateway package (`ImageGenerateInput` and friends) are
 * deliberately absent: contracts does not depend on it. `AgentToolModelClientOf`
 * below takes them as a type parameter instead, so each side pins them from the
 * package it already depends on and assignability still checks the pair.
 */

import {
  ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
  type ArtifactStorage,
} from "../artifact-storage";
import type {
  ArtifactPublishResult,
  ArtifactPublishSpec,
  ArtifactPublisher,
  ArtifactWriteContext,
} from "../artifact-write";
import type { AgentToolModelCallOptions } from "./model-call";
import type { CommittedArtifactToolResult } from "./define";

/* -------------------------------------------------------------------------- */
/* Turn context                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A tool's runtime selection for this turn, as the turn pipeline resolved it.
 *
 * `options`/`selection` stay `unknown`: their shape is the capability's own
 * option schema, declared in its manifest, and the host only carries them.
 */
export type AgentToolRuntimeToolState = {
  readonly enabled?: boolean;
  readonly options?: unknown;
  readonly selection?: unknown;
};

/**
 * Who and what this turn is, as a capability sees it.
 *
 * Everything here is host vocabulary — tenancy, ids, trace, the turn's own
 * decisions about which tools may bind. A capability reads what it needs and
 * ignores the rest.
 */
export type AgentToolTurnContext = {
  /**
   * Whatever each capability's turn preflight parked, keyed by tool name.
   * Handed over whole and unread: the host carries it, each capability takes
   * its own entry out of it. This field is why the host no longer carries
   * three image-shaped fields of its own.
   */
  readonly turnState: Readonly<Record<string, unknown>>;
  /** True when the user or policy explicitly denied this tool for the turn. */
  readonly isToolDenied: (toolName: string) => boolean;
  readonly parentSpanId?: string;
  readonly runtimeTools: Readonly<Record<string, AgentToolRuntimeToolState>>;
  /**
   * The turn's binding decision — selection, permissions and mode combined.
   * Distinct from `isToolDenied`: a tool can be undenied and still not bound.
   */
  readonly shouldBindAgentTool: (toolName: string) => boolean;
  /**
   * The user message that started the work, which is not always
   * `userMessageId` — a resumed or replayed turn has a newer one.
   */
  readonly sourceUserMessageId?: string;
  readonly teamId: string;
  readonly threadId: string;
  /** Root durable chat run that owns user-visible outputs from this tool. */
  readonly threadRunId?: string;
  readonly traceId?: string;
  readonly userId: string;
  readonly userMessageId: string;
  readonly webAccessEnabled: boolean;
  readonly workspaceId: string;
};

/* -------------------------------------------------------------------------- */
/* Services: artifacts                                                         */
/* -------------------------------------------------------------------------- */

/**
 * An artifact row as a capability may read it back.
 *
 * Narrower than the host's row on purpose: status and payload are what a tool
 * needs to decide whether to reuse or to keep waiting, and everything else is
 * the host's storage business.
 */
export type AgentToolArtifactRecord = {
  readonly id: string;
  readonly status: string;
  /** Nullable in the row, so a reader has to decide what an untitled artifact shows. */
  readonly title: string | null;
  readonly payloadJson?: unknown;
  /** Why a failed artifact failed, when the host recorded a reason. */
  readonly errorMessage?: string | null;
  /** The row's artifact type, so a republisher can refuse a type mismatch. */
  readonly artifactType?: string;
  /** The version a republish read, for the concurrency check on the write. */
  readonly currentVersionNo?: number;
};

/** Row primitives take the artifact type as an argument — see below. */
export type AgentToolArtifactRecordInput = {
  readonly artifactId: string;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly title: string;
  readonly prompt: string;
  readonly payload: Record<string, unknown>;
  /** Idempotency token, when the caller asked for "the artifact for this request". */
  readonly requestKey?: string | null;
};

export type AgentToolReadyArtifactRecordInput = AgentToolArtifactRecordInput & {
  readonly storageBucket?: string | null;
  readonly storageKey?: string | null;
  readonly previewStorageKey?: string | null;
  readonly previewMetadata?: Record<string, unknown> | null;
};

export type AgentToolReusableArtifactQuery = {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly artifactType: string;
  readonly statuses: readonly string[];
  readonly limit?: number;
  readonly requestKey?: string;
  readonly matchesPayload?: (payload: Record<string, unknown>) => boolean;
};

/**
 * The artifact write path, as every capability receives it.
 *
 * Not one member names an artifact type. Where the host needs the type it takes
 * it as a parameter, because the capability knows its own type — it declared it
 * in the manifest it is handed — and the host does not need to.
 */
export type AgentToolArtifactServices = {
  /**
   * The one way an artifact is published. What is written is whatever the spec
   * says.
   */
  readonly publishArtifact: ArtifactPublisher["publishArtifact"];
  /**
   * The two-phase half of the same door, for a capability whose artifact
   * outlives the call that asked for it.
   */
  readonly openArtifact: (input: {
    readonly context: ArtifactWriteContext;
    readonly spec: ArtifactPublishSpec;
    readonly artifactId?: string;
  }) => Promise<{ readonly artifactId: string }>;
  /**
   * Publish over an existing ready artifact as its next version — an edit
   * republishing over itself. The caller passes the `currentVersionNo` it read
   * so two concurrent republishes cannot both win; a failed republish never
   * touches the published version.
   */
  readonly republishArtifact: (input: {
    readonly context: ArtifactWriteContext;
    readonly artifactId: string;
    readonly spec: ArtifactPublishSpec;
    readonly expectedVersionNo?: number;
    /** Host invocation signal; never sourced from model-authored arguments. */
    readonly signal?: AbortSignal;
  }) => Promise<ArtifactPublishResult>;
  /** The generic artifact-row primitives, artifact type first. */
  readonly createPendingArtifact: (
    artifactType: string,
    input: AgentToolArtifactRecordInput,
  ) => Promise<unknown>;
  readonly createReadyArtifact: (
    artifactType: string,
    input: AgentToolReadyArtifactRecordInput,
  ) => Promise<unknown>;
  readonly findArtifact: (input: {
    readonly teamId: string;
    readonly workspaceId: string;
    readonly artifactId: string;
  }) => Promise<AgentToolArtifactRecord | null>;
  /**
   * Reuse lookup. Which type, which statuses and what makes a row a match are
   * the caller's query, not the host's knowledge.
   */
  readonly findReusableArtifact: (
    query: AgentToolReusableArtifactQuery,
  ) => Promise<AgentToolArtifactRecord | null>;
};

/**
 * A ready artifact version after the host has applied tenant, visibility, type,
 * and current-version checks. The payload remains inside trusted capability
 * code; model-visible tool output must project it to paths, digests, and opaque
 * handles instead of returning storage coordinates.
 */
export type AgentToolAuthorizedArtifactVersion = {
  readonly artifactId: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type AgentToolArtifactVersionServices = {
  readonly readAuthorizedCurrentVersion: (input: {
    readonly artifactId: string;
    readonly expectedArtifactType: string;
  }) => Promise<AgentToolAuthorizedArtifactVersion | null>;
};

export type AgentToolCurrentRunArtifactPublicationServices = {
  readonly allocateArtifactId: () => string;
  readonly cleanupPreallocatedArtifact: (artifactId: string) => Promise<void>;
  readonly publishCommitted: (input: {
    readonly artifactType: string;
    readonly mode:
      | { readonly kind: "create"; readonly artifactId: string }
      | {
          readonly kind: "republish";
          readonly artifactId: string;
          readonly expectedVersionNo: number;
        };
    readonly payload: Readonly<Record<string, unknown>>;
    readonly previewMetadata?: Readonly<Record<string, unknown>> | null;
    readonly previewStorageKey?: string | null;
    readonly prompt: string;
    readonly semanticRequestKey: string;
    readonly storageBucket?: string | null;
    readonly storageKey?: string | null;
    readonly title: string;
    readonly workflowVersion: string;
  }) => Promise<
    | {
        readonly ok: true;
        readonly result: CommittedArtifactToolResult;
        readonly reused: boolean;
        readonly versionNo: number;
      }
    | {
        readonly ok: false;
        readonly reason:
          | "artifact_not_found"
          | "forbidden"
          | "message_unavailable"
          | "run_inactive"
          | "version_conflict";
      }
  >;
};

/* -------------------------------------------------------------------------- */
/* Services: retrieval, web, citations                                         */
/* -------------------------------------------------------------------------- */

/** One citable chunk, as retrieval hands it to a tool. */
export type AgentToolRetrievalChunk = {
  readonly citation: string;
  readonly chunkId: string;
  readonly content: string;
  readonly sourceTitle?: string;
};

export type AgentToolRetrievalServices = {
  /**
   * Runs the turn's retrieval and records the call against the turn trace. The
   * optional runtime identifies the tool call so the retrieval hangs off it in
   * the trace instead of off the turn root.
   */
  readonly searchSources: (
    query: string,
    toolCallRuntime?: {
      readonly toolCallId?: string;
      readonly toolName?: string;
    },
  ) => Promise<readonly AgentToolRetrievalChunk[]>;
};

/**
 * The web provider port.
 *
 * Declared here rather than in the capability that consumes it because both
 * ends are downstream of it: the host constructs the provider, a capability
 * calls it. Same move `ArtifactStorage` makes for object storage.
 */
export type AgentToolWebSearchInput = {
  readonly query: string;
  readonly limit: number;
  readonly includeContent?: boolean;
  readonly fresh?: boolean;
  readonly lang?: string;
  readonly country?: string;
};

export type AgentToolWebSearchResultItem = {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  readonly markdown?: string;
  readonly wordCount?: number;
  readonly truncated?: boolean;
  readonly publishedAt?: string;
  readonly source?: string;
};

export type AgentToolWebSearchResult = {
  readonly provider: string;
  readonly query: string;
  readonly count: number;
  readonly results: readonly AgentToolWebSearchResultItem[];
};

export type AgentToolWebFetchInputItem = {
  readonly url: string;
  readonly prompt?: string;
};

export type AgentToolWebFetchInput = {
  readonly fresh?: boolean;
  readonly items: readonly AgentToolWebFetchInputItem[];
};

export type AgentToolWebFetchResultItem = {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly markdown: string;
  readonly wordCount: number;
  readonly truncated: boolean;
  readonly error?: string;
};

export type AgentToolWebFetchResult = {
  readonly provider: string;
  readonly count: number;
  readonly results: readonly AgentToolWebFetchResultItem[];
};

export type AgentToolWebProvider = {
  readonly name: string;
  search(input: AgentToolWebSearchInput): Promise<AgentToolWebSearchResult>;
  fetch(input: AgentToolWebFetchInput): Promise<AgentToolWebFetchResult>;
};

export type AgentToolExternalCitationInput = {
  readonly origin: string;
  readonly externalUri: string;
  readonly sourceTitle?: string | null;
  readonly content: string;
  readonly excerptContent?: string;
  readonly fullContent?: string;
  readonly score?: number | null;
};

export type AgentToolExternalCitation = {
  readonly citation: string;
};

/**
 * The turn's citation ledger. Declared with method syntax deliberately: the
 * host's registry narrows `origin` to the tool names it knows, and method-style
 * parameter bivariance is what lets that stricter implementation satisfy this
 * capability-agnostic port.
 */
export type AgentToolCitationRegistry = {
  addExternal(input: AgentToolExternalCitationInput): AgentToolExternalCitation;
};

/* -------------------------------------------------------------------------- */
/* Services: files, sandbox, queue, logging                                    */
/* -------------------------------------------------------------------------- */

/** One raw read, in the agent filesystem's own result shape. */
export type AgentToolFileReadResult = {
  readonly data?: {
    readonly content: string | readonly string[] | Uint8Array | Buffer;
    readonly mimeType?: string;
  };
  readonly error?: unknown;
};

export type AgentToolFileDownloadResult = {
  readonly path: string;
  readonly content: Uint8Array | Buffer | null;
  readonly error?: unknown;
};

export type AgentToolFilesystemServices = {
  readonly readRaw?: (
    path: string,
  ) => Promise<AgentToolFileReadResult> | AgentToolFileReadResult;
  readonly downloadFiles?: (
    paths: readonly string[],
  ) =>
    | Promise<readonly AgentToolFileDownloadResult[]>
    | readonly AgentToolFileDownloadResult[];
};

export type AgentToolSandboxHostLimits = {
  readonly commandTimeoutMs: number;
  readonly maxOutputChars: number;
  readonly maxUploadFileBytes: number;
  readonly maxUploadTotalBytes: number;
  readonly maxDownloadFileBytes: number;
  readonly maxDownloadTotalBytes: number;
  readonly maxCaptureFiles: number;
};

export type AgentToolSandboxServices = {
  readonly allowedReadRoots?: readonly string[];
  readonly downloadCurrentFile: (input: {
    readonly sandboxPath: string;
    /** Trusted host cancellation; never sourced from model arguments. */
    readonly signal?: AbortSignal;
    /** Trusted host deadline, clamped again by the sandbox runtime. */
    readonly timeoutMs?: number;
  }) => Promise<Buffer | Uint8Array>;
  /** Trusted tools require a concrete provider session before side effects. */
  readonly ensureCurrentSession?: () => Promise<{
    readonly sessionGeneration: string;
    /** Effective trusted-host ceilings after backend configuration/clamping. */
    readonly hostLimits?: AgentToolSandboxHostLimits;
    /** Host-resolved executable paths keyed by catalog identity. */
    readonly runtimeAssets?: Readonly<Record<string, string>>;
  }>;
  readonly uploadCurrentFiles?: (
    files: readonly {
      readonly path: string;
      readonly bytes: Uint8Array;
    }[],
    options?: {
      /** Trusted host cancellation; never sourced from model arguments. */
      readonly signal?: AbortSignal;
      /** Trusted host deadline, clamped again by the sandbox runtime. */
      readonly timeoutMs?: number;
    },
  ) => Promise<void>;
  readonly listCurrentFiles?: (input: {
    readonly root: string;
  }) => Promise<readonly string[]>;
  readonly executeCurrent?: (input: {
    readonly command: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly exitCode: number | null;
    readonly output: string;
    readonly truncated?: boolean;
  }>;
  readonly captureCurrentTree?: (input: {
    readonly root: string;
    readonly maxFiles: number;
    readonly maxTotalBytes: number;
    /** Trusted host cancellation; never sourced from model arguments. */
    readonly signal?: AbortSignal;
    /** Trusted host deadline, clamped again by the sandbox runtime. */
    readonly timeoutMs?: number;
  }) => Promise<
    readonly {
      readonly relativePath: string;
      readonly bytes: Uint8Array;
    }[]
  >;
};

/**
 * Hard ceilings for the new generic host ports. Backends may configure smaller
 * limits but must never accept a caller-supplied value above these bounds.
 */
export const AGENT_TOOL_HOST_LIMITS = Object.freeze({
  operationClaimMaxKeys: 256,
  protectedJsonMaxBytes: 256 * 1024,
  sandboxCaptureMaxFiles: 200,
  sandboxCaptureMaxTotalBytes: ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
  sandboxCommandMaxOutputChars: 80_000,
  sandboxCommandMaxTimeoutMs: 10 * 60 * 1000,
  workBlobMaxBytes: ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
  workBlobMaxTtlSeconds: 24 * 60 * 60,
});

export type AgentToolReceiptServices = {
  readonly issueCurrentRunReceipt: (input: {
    readonly producerToolName: string;
    readonly producerToolCallId: string;
    readonly schemaVersion: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }) => Promise<{ readonly receiptId: string }>;
  readonly resolveCurrentRunReceipt: (input: {
    readonly receiptId: string;
    readonly producerToolName: string;
    readonly expectedSchemaVersion?: string;
    readonly executionScope: "root_only";
  }) => Promise<unknown | null>;
};

export type AgentToolOperationClaimedItem =
  | {
      readonly semanticKey: string;
      readonly action: "execute";
      readonly claimToken: string;
    }
  | {
      readonly semanticKey: string;
      readonly action: "reuse";
      readonly observationId: string;
      readonly observation: unknown;
    };

export type AgentToolOperationClaimManyResult =
  | {
      readonly kind: "claimed";
      readonly items: readonly AgentToolOperationClaimedItem[];
    }
  | { readonly kind: "wait"; readonly ownerToolCallId: string }
  | {
      readonly kind: "unknown";
      readonly code: "SIDE_EFFECT_OUTCOME_UNKNOWN";
    };

export type AgentToolOperationCacheServices = {
  /**
   * The host canonicalizes/sorts/deduplicates keys and claims them all-or-none.
   * Team/workspace/run identity is injected from the active tool context.
   */
  readonly claimMany: (input: {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly semanticKeys: readonly string[];
    readonly executionScope: "root_only";
  }) => Promise<AgentToolOperationClaimManyResult>;
  readonly complete: (input: {
    readonly toolName: string;
    readonly semanticKey: string;
    readonly claimToken: string;
    readonly observation: Readonly<Record<string, unknown>>;
  }) => Promise<{ readonly observationId: string }>;
  readonly markUnknown: (input: {
    readonly toolName: string;
    readonly semanticKey: string;
    readonly claimToken: string;
    readonly reason: string;
  }) => Promise<void>;
};

export type AgentToolVerifiedWorkBlob = {
  readonly blobRef: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly contentDigest: string;
};

export type AgentToolWorkBlobServices = {
  readonly putIfAbsent: (input: {
    readonly semanticKey: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly contentDigest: string;
    readonly ttlSeconds: number;
  }) => Promise<{
    readonly blobRef: string;
    readonly contentDigest: string;
  }>;
  readonly getVerified: (input: {
    readonly blobRef: string;
    readonly contentDigest: string;
  }) => Promise<Pick<
    AgentToolVerifiedWorkBlob,
    "bytes" | "contentType"
  > | null>;
  readonly getBySemanticKey: (input: {
    readonly semanticKey: string;
  }) => Promise<AgentToolVerifiedWorkBlob | null>;
  /** Delete every WIP object in the host-injected current-run scope. */
  readonly deleteScope: () => Promise<void>;
};

export type AgentToolDeliverableJob = {
  /** Host-normalized job id; capabilities never inspect BullMQ internals. */
  readonly id: string;
  /** Fence publication and remove the job when BullMQ has not started it yet. */
  readonly cancel: () => Promise<void>;
  /** Resolves with the worker result and rejects with the terminal job error. */
  readonly waitUntilFinished: (input?: {
    readonly timeoutMs?: number;
  }) => Promise<unknown>;
};

export type AgentToolQueueServices = {
  /**
   * Dispatch counterpart of the worker's pipeline registry: the capability
   * supplies the job name it declared in its manifest, the host supplies the
   * queue and its retry/idempotency policy.
   */
  readonly enqueueDeliverableJob: (input: {
    readonly jobName: string;
    readonly jobId: string;
    readonly payload: Record<string, unknown>;
  }) => Promise<AgentToolDeliverableJob>;
};

export type AgentToolLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type AgentToolMediaServices = {
  readonly probeAudioDurationSeconds: (input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  }) => Promise<number | null>;
};

/**
 * How the turn resolved the model to execute with — global alias, BYOK route,
 * thinking budget. Passed through to whatever downstream call a capability
 * makes so a queued deliverable runs on the same model the turn did.
 */
export type AgentToolLlmExecutionConfig = {
  readonly profileAlias?: string;
  readonly modelAlias?: string;
  readonly providerModel?: string;
  readonly executionMode?: "GLOBAL" | "BYOK";
  readonly providerHint?: string;
  readonly byokModelId?: string;
  readonly credentialId?: string;
  readonly byok?: {
    readonly provider: string;
    readonly providerKind?: string;
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly apiKeyRef?: string;
    readonly defaultHeaders?: Record<string, string>;
  };
  readonly thinking?: {
    readonly mode?: "auto" | "off" | "effort";
    readonly enabled?: boolean;
    readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    readonly includeReasoning?: boolean;
    readonly budgetTokens?: number;
  };
};

/* -------------------------------------------------------------------------- */
/* Services: the model gateway                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How a capability asks for a model client.
 *
 * `feature` is the reason the host cannot guess: it is the label the spend
 * settles under, and only the caller knows what the call is for. The host used
 * to hardcode one capability's label here, which meant every other capability's
 * spend would have been filed under it.
 */
export type AgentToolModelClientRequest = {
  readonly gatewayConfigId: string;
  readonly feature: string;
};

/**
 * A gateway surface, as much of it as this package can name: model kinds, each
 * a set of `(request, options)` calls. The concrete request and result types
 * live in the gateway package, which contracts does not depend on — each side
 * substitutes its own below.
 */
export type AgentToolGatewaySurface = Readonly<
  Record<string, Readonly<Record<string, (...args: never[]) => unknown>>>
>;

/**
 * Rewrites a gateway surface into the client a capability is handed: the same
 * model kinds and the same methods, with the host's raw per-request options
 * replaced by the billing identity the caller must supply.
 *
 * This is what keeps the host from speaking one capability's vocabulary. It
 * exposed `{ images: { generate } }` once — a single modality, hardcoded — so
 * a capability that needed transcription or embeddings could not be served at
 * all without editing the host.
 */
export type AgentToolModelClientOf<TGateway> = {
  readonly [Kind in keyof TGateway]: {
    readonly [Method in keyof TGateway[Kind]]: TGateway[Kind][Method] extends (
      request: infer TRequest,
      ...rest: never[]
    ) => infer TResult
      ? (request: TRequest, options: AgentToolModelCallOptions) => TResult
      : never;
  };
};

/**
 * The gateway service in the host bag.
 *
 * `TGateway` is bound by the host to its billed gateway and by a capability to
 * the kinds it actually calls, so the assignability between the two is what
 * checks that the host really exposes the kind the capability asked for.
 */
export type AgentToolModelGatewayService<TGateway = AgentToolGatewaySurface> = {
  /**
   * Opens a client that bills for itself.
   *
   * The caller supplies the billing identity per call — including an
   * idempotency key derived from an id it allocates before the call — so
   * settlement happens with the model call rather than after the artifact is
   * published. Previously a failure between the two left the tokens burned and
   * nothing charged.
   */
  readonly getClient: (
    input: AgentToolModelClientRequest,
  ) => Promise<AgentToolModelClientOf<TGateway>>;
};

/* -------------------------------------------------------------------------- */
/* The bag                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything the host hands every capability. Optional members are the ones a
 * turn may genuinely not have (no sandbox was started, no filesystem mounted);
 * a capability that needs one checks for it and declines to bind.
 *
 * Adding a member that only one capability reads is the mistake this type
 * exists to prevent — see the header.
 */
export type AgentToolHostServices<TGateway = AgentToolGatewaySurface> = {
  readonly artifacts: AgentToolArtifactServices;
  /** Optional until a durable current-run context installs the trusted reader. */
  readonly artifactVersions?: AgentToolArtifactVersionServices;
  readonly currentRunArtifacts?: AgentToolCurrentRunArtifactPublicationServices;
  readonly citationRegistry: AgentToolCitationRegistry;
  readonly filesystem?: AgentToolFilesystemServices;
  readonly llm?: AgentToolLlmExecutionConfig;
  readonly logger: AgentToolLogger;
  readonly media?: AgentToolMediaServices;
  readonly modelGateway: AgentToolModelGatewayService<TGateway>;
  readonly operationCache?: AgentToolOperationCacheServices;
  readonly queue: AgentToolQueueServices;
  readonly receipts?: AgentToolReceiptServices;
  readonly retrieval: AgentToolRetrievalServices;
  readonly sandbox?: AgentToolSandboxServices;
  readonly storage: ArtifactStorage;
  readonly workBlobs?: AgentToolWorkBlobServices;
  readonly webProvider: AgentToolWebProvider | null;
};
