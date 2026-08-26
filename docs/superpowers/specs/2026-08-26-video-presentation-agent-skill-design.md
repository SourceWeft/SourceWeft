# Video Presentation Agent Skill V2 Design

Date: 2026-08-26

## Decision

Run new Video Presentation requests as an ordinary SourceWeft skill inside the
existing root DeepAgent. The agent plans, calls a small set of typed video and
sandbox tools, observes their results, repairs concrete failures, and publishes
only after a deterministic acceptance gate passes.

Do not add a video subagent, a video-specific agent runtime, a controller
service, a workflow engine, or a database table. Do not keep the current fixed
eleven-stage worker pipeline as the orchestrator for new requests.

The selected architecture is:

```text
existing SourceWeft DeepAgent
  -> selected video-presentation skill
  -> existing planning/filesystem/sandbox staging tools
  -> load_video_presentation (edits only)
  -> generate_video_assets
  -> generate_video_narration
  -> validate_video_presentation
  -> publish_video_presentation
  -> existing ArtifactPublisher and artifact/version store
```

The existing `generate_video_presentation` worker pipeline remains a legacy
compatibility path while queued jobs and retained history still depend on it.
It is not a per-request fallback for the V2 path.

## Relationship to the State-Recovery Design

The prior
`2026-08-25-video-presentation-state-recovery-design.md` remains authoritative
for:

- historical `artifact` and `artifact_output` render-block compatibility;
- legacy `video_presentation_processing_result` decoding;
- legacy worker jobs already queued or persisted;
- terminal wait, cancellation, run fencing, and truthful failure presentation
  on the old `generate_video_presentation` tool;
- structured-output error classification in the old pipeline.

This design supersedes the prior design only for orchestration of new Video
Presentation requests after the V2 cutover. In particular, new V2 requests do
not use fixed stages, stage attempts, automatic failed-artifact regeneration,
or background-processing success responses.

## Why This Architecture

SourceWeft already contains the necessary platform primitives:

- DeepAgents with Postgres checkpointing;
- `write_todos`, filesystem working memory, synchronous delegation, HITL,
  context compression, tool/model error middleware, call limits, and
  observability;
- capability-owned typed tools bound per turn;
- durable `chat_thread_runs`, Redis run streaming, BullMQ, cancellation, and
  heartbeat handling;
- sandbox prepare/execute/collect tools and sandbox operation receipts;
- billed chat, vision, image, and TTS provider access;
- an artifact publisher that supports payload-only artifacts, attachments,
  previews, idempotency, versions, and run publication fencing.

The current Video Presentation implementation bypasses the agent loop by
binding one coarse black-box tool whose worker owns planning, execution,
retry, validation, and publication. The missing capability is not another
runtime. It is a safe video-specific tool surface that lets the existing agent
observe facts and choose the next action.

The existing PPT Deck skill is the local reference pattern: a skill guides the
agent through sandbox work, QA, repair, and publication using typed tools. Video
Presentation adopts that boundary while retaining video-specific validation,
audio, browser-preview, and payload requirements.

## External Lessons Applied Selectively

The design borrows ideas without adopting another project's runtime:

- LobeHub: model -> typed tool -> result -> model loops, progressive tool
  exposure, cancellation, and explicit terminal reasons. It does not copy the
  dedicated `agent_operations` store or inline MIME artifacts.
- SurfSense: a deliverable tool must return a terminal receipt instead of
  presenting pending work as success. It does not copy SurfSense's fixed video
  graph.
- OpenHands: actions execute in an isolated runtime and return observations the
  agent can use for repair. It does not allow an unrestricted shell to publish
  trusted artifacts.
- ComfyUI: stable action identities, partial reuse, explicit progress, and
  distinct success/error/interrupted outcomes. It does not encode the semantic
  workflow as a fixed node graph.
- Remotion Agent Skills: progressively disclosed domain guidance for project
  creation, markup, rendering, and validation. Skill text remains guidance,
  not a durable state machine.

## Goals

1. Let the existing DeepAgent decide how to plan, build, validate, and repair a
   video presentation from actual tool observations.
2. Eliminate product-visible and orchestration-level fixed attempt counts for
   new V2 requests.
3. Keep deterministic security, billing, idempotency, cancellation,
   validation, and publication invariants outside model control.
4. Produce a ready artifact card in the live conversation without requiring a
   page refresh.
5. Make live and reloaded history converge on the same persisted facts.
6. Require real Remotion runtime evidence, complete narration coverage, and a
   final cover image before publication by default.
7. Preserve old jobs, artifacts, versions, messages, and user-authored working
   tree changes.

## Non-Goals

- Creating a generic workflow framework or action event store.
- Adding a `video-studio` subagent in V2.
- Adding a table, column, migration, or backfill.
- Replacing DeepAgents, LangGraph checkpointing, BullMQ, or the artifact store.
- Rendering the final MP4 on the server. The ready artifact remains a
  browser-previewable and browser-exportable Remotion project.
- Silently switching model, provider, skill, tool, implementation, or data
  source after a failure.
- Retrofitting every existing deliverable capability to the new skill model.
- Deleting legacy readers while retained history still needs them.

## Constraints

- New V2 generation stays in the originating chat turn until ready, failed,
  cancelled, or explicitly blocked.
- `pending`, `waiting`, or `processing` is never a success result.
- A provider/model change requires explicit user authority.
- A user stop propagates a cancellation signal through the active tool and
  sandbox/provider ports that support cancellation, stops future actions, and
  always closes the publication fence. An already-running upstream operation
  that cannot be physically cancelled may finish until its bounded timeout,
  but its result is discarded and cannot publish.
- The skill may recommend a happy path, but the host must not encode a fixed
  semantic stage order or retry count.
- V2 video tools execute as ordinary tools in the existing durable chat-run
  worker. They do not introduce a second BullMQ workflow or promise automatic
  continuation of the same turn after process death.
- Existing unrelated dirty-worktree changes must not be overwritten or folded
  into implementation commits.

V2 turn preparation resolves and records the selected target for each model
kind it may use (chat, image, vision, and TTS). Model-gateway calls carry an
enforced `fallbackPolicy: "none"` option; the current failover runner must honor
it rather than merely declaring an unused flag. An upstream router such as an
explicitly selected OrcaRouter target may choose its own resolved model as part
of that provider contract, but SourceWeft records the resolved provider/model
and does not add another route candidate silently.

## Runtime Ownership

### Agent state

The existing LangGraph/DeepAgents checkpoint is authoritative for messages,
todos, tool calls, tool observations, resumable interrupts, and context
summaries.

### Run state

`chat_thread_runs` is authoritative for the active turn, its queue identity,
status, heartbeat, cancellation, stream offset, and recoverable snapshot.

### Work state

The current sandbox and workfiles are authoritative for in-progress project
files. The model necessarily emits or reads the code it creates, so V2 does not
pretend generated code never enters model context. Durable copies, large logs,
stills, audio bytes, and unchanged files remain in workfiles/sandbox; tools
return concise paths, digests, metrics, and diagnostics. V2 keeps the existing
1-12 slide bound, introduces a per-scene source-size ceiling in the canonical
schema, and relies on existing context compression when iterative repair grows
the turn.

### Operation identity

V2 does not add an operation table. Every meaningful action is correlated by
the existing tuple:

```text
runId + toolCallId + toolName + root execution namespace
```

That tuple is the tracing/correlation identity, not the semantic idempotency
identity: a model can issue the same semantic call twice with different tool
call ids. Within one active run, video tools derive a separate key that
deliberately excludes `toolCallId`:

```text
sha256(
  workflowVersion
  + runId
  + toolName
  + normalizedScope
  + normalizedInput
  + relevantEnvironmentIdentity
)
```

Per-track narration keys add slide number, normalized text, voice/profile
identity, and output format. The environment identity includes the configured
provider/model or voice, sandbox session generation where relevant, validator
version, and edited artifact/version identity. Tool-call identity remains
attached for trace causation.

A new tool-call id with the same semantic key looks up the canonical
observation in the protected current-run operation cache. Successful and
deterministic-failure observations are reused; a narration success additionally
requires its WIP blob digest to verify before restaging. A transient observation
may run again only after its recorded retry time, provider health epoch, or
sandbox session identity changes and existing call/run limits plus available
billing balance permit it. ToolMessages remain display and trace records, not
the cache authority.

V2 does not claim exactly-once external provider execution across process
death. The current durable-run recovery marks a dead run failed rather than
resuming its graph. If a provider completed but the process died before the
ToolMessage became durable, the next user-authorized run reports the prior
outcome as unknown unless provider or committed artifact facts can reconcile
it. It never automatically replays that ambiguous call. Internal user billing
and artifact publication remain idempotent.

### Published truth

The artifact row and current artifact version are authoritative for a published
video project. Message `artifact_output` is the immutable conversation
reference to that committed version. Run snapshots and realtime events are
projections; they never create or revoke publication truth.

## Capability Surface

The V2 skill declares the tools it needs:

```text
write_todos
ls/read_file/write_file/edit_file/glob/grep
prepare_sandbox_workspace
load_video_presentation
generate_video_assets
generate_video_narration
validate_video_presentation
publish_video_presentation
```

DeepAgents still supplies its normal root planning/filesystem tools, and other
turn configuration may contribute read-only tools. The V2 command policy
disables `task` and all async-task tools for the turn, so no child agent can
author or mutate the video project. It requires that the five trusted V2 video
tools are bound at the root and that the legacy black-box video tool is not
bound for a V2 command.

The same command policy also disables the generic `generate_image`, `execute`,
and `collect_sandbox_outputs` tools for V2. `generate_video_assets` provides
bounded image generation, the validator owns trusted build/render execution,
and publication owns collection. `prepare_sandbox_workspace` remains available
only for deterministic staging of authored workfiles.

Add a capability-agnostic execution-scope field to agent-tool definitions:

```ts
type AgentToolExecutionScope = "root_only" | "inheritable";
```

The default remains `inheritable`. The five V2 video tools are `root_only` and
are filtered out when `turn-assembly` constructs child toolsets. The
command-scoped tool policy additionally removes delegation tools, making
root-only execution enforceable rather than prompt advice. V2 does not register
or invoke a video/general-purpose subagent.

The root skill uses progressive disclosure. `SKILL.md` is the router and holds
only the essential workflow, guardrails, and tool contracts. References cover
Remotion markup, narration/timeline rules, visual direction, editing, quality
gates, and recovery. The happy path does not load every reference.

The skill does not expose provider credentials, artifact repositories, raw
storage APIs, arbitrary host filesystem access, or publication state mutation.

### Required generic host ports

The current agent-tool sandbox service only supports downloading one current
file. Before V2 tools can be bound, extend that capability-agnostic port with
trusted operations over the already-selected sandbox runtime:

```ts
type AgentToolSandboxServices = {
  allowedReadRoots?: readonly string[];
  ensureCurrentSession(): Promise<{ sessionGeneration: string }>;
  uploadCurrentFiles(files: readonly { path: string; bytes: Uint8Array }[]): Promise<void>;
  listCurrentFiles(input: { root: string }): Promise<readonly string[]>;
  downloadCurrentFile(input: { sandboxPath: string }): Promise<Uint8Array>;
  executeCurrent(input: {
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number | null; output: string; truncated?: boolean }>;
  captureCurrentTree(input: {
    root: string;
    maxFiles: number;
    maxTotalBytes: number;
  }): Promise<readonly { relativePath: string; bytes: Uint8Array }>;
};
```

The host owns path canonicalization, symlink rejection, size/file ceilings,
session identity, and signal wiring. Provider runtimes that support command
cancellation receive the signal. A provider that cannot cancel an in-flight
command may finish until its existing timeout, but its result is discarded
after cancellation and publication remains fenced. The UI must not claim that
such a command was physically terminated when only the wait was stopped.

Add an authorized current-version reader rather than exposing the raw artifact
repository:

```ts
type AgentToolArtifactVersionServices = {
  readAuthorizedCurrentVersion(input: {
    artifactId: string;
    expectedArtifactType: string;
  }): Promise<{
    artifactId: string;
    versionId: string;
    versionNo: number;
    payload: Record<string, unknown>;
    preview?: { bytes: Uint8Array; contentType: string };
  } | null>;
};
```

The host injects actor/team/workspace identity, applies `canViewContent`, and
returns only the current ready version. Raw tenant-scoped repository lookup is
not sufficient and is not exposed to the capability.

Add a host-only receipt port for load/validation/publication evidence:

```ts
type AgentToolReceiptServices = {
  issueCurrentRunReceipt(input: {
    producerToolName: string;
    producerToolCallId: string;
    schemaVersion: string;
    payload: Record<string, unknown>;
  }): Promise<{ receiptId: string }>;
  resolveCurrentRunReceipt(input: {
    receiptId: string;
    producerToolName: string;
    executionScope: "root_only";
  }): Promise<unknown | null>;
};
```

The host injects current workspace/run identity. Receipts live in a bounded,
host-only `chat_thread_runs.snapshot_json.trustedReceipts` map that every
snapshot merge preserves but never sends as model-visible prompt content.
Message/tool output carries only the receipt id and display-safe summary.
Context compression may remove or summarize an ordinary ToolMessage without
removing the trusted receipt. The host resolves only a schema-valid receipt
from the same root namespace. The model cannot provide or override tenant/run
identity.

Add a compression-invariant semantic observation cache in the same bounded
host-only run-snapshot channel:

```ts
type AgentToolOperationCacheServices = {
  claimMany(input: {
    toolName: string;
    toolCallId: string;
    semanticKeys: string[];
    executionScope: "root_only";
  }): Promise<
    | {
        kind: "claimed";
        items: Array<
          | { semanticKey: string; action: "execute"; claimToken: string }
          | {
              semanticKey: string;
              action: "reuse";
              observationId: string;
              observation: unknown;
            }
        >;
      }
    | { kind: "wait"; ownerToolCallId: string }
    | { kind: "unknown"; code: "SIDE_EFFECT_OUTCOME_UNKNOWN" }
  >;
  complete(input: {
    toolName: string;
    semanticKey: string;
    claimToken: string;
    observation: Record<string, unknown>;
  }): Promise<{ observationId: string }>;
  markUnknown(input: {
    toolName: string;
    semanticKey: string;
    claimToken: string;
    reason: string;
  }): Promise<void>;
};
```

`claimMany` canonicalizes to sorted unique keys and is atomic under one current
run-row lock. It is all-or-nothing: completed items may be returned for reuse
and every remaining free key is claimed for this owner in the same transaction;
if any key is owned by a foreign in-progress call or is unknown, the method
returns wait/unknown and leaves no new partial claims. The protected entries
record `in_progress`, owner tool call, and fencing tokens before any provider or
sandbox side effect. Only those tokens can complete or mark operations unknown.
A concurrent follower waits for the owner through the current run
stream/snapshot, or reuses completed observations; it never invokes the
upstream concurrently. Both batch tools must finish `claimMany` before their
first provider call. If the owner process dies, stale-run recovery fences all
of its in-progress claims as `unknown` and no later call automatically replays
them.

A replaying tool call returns a display-safe alias to the canonical observation
and reuses its receipt id; it does not issue a second receipt. Duplicate
ToolMessages are allowed as trace entries, while the protected cache contains
one canonical observation per semantic key.

Add a capability-agnostic work-in-progress blob port backed by existing object
storage, not a table:

```ts
type AgentToolWorkBlobServices = {
  putIfAbsent(input: {
    semanticKey: string;
    bytes: Uint8Array;
    contentType: string;
    contentDigest: string;
    ttlSeconds: number;
  }): Promise<{ blobRef: string; contentDigest: string }>;
  getVerified(input: {
    blobRef: string;
    contentDigest: string;
  }): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  getBySemanticKey(input: {
    semanticKey: string;
  }): Promise<{
    blobRef: string;
    bytes: Uint8Array;
    contentType: string;
    contentDigest: string;
  } | null>;
  deleteScope(): Promise<void>;
};
```

The host builds tenant/workspace/run-scoped keys; capability code cannot supply
raw object keys. Successful image/TTS bytes are put before the ToolMessage
completes. The observation stores `blobRef` plus digest as the durable byte
authority and also stages the bytes into the current sandbox. If the sandbox is
recreated, the tool rehydrates the staged path from the blob without another
provider call. Scoped blobs expire and are deleted best-effort after
publication or terminal run cleanup.

The protected operation cache never evicts entries while the run is active.
Its capacity is bounded by the existing run tool-call limit; a full cache blocks
a new claim before side effects. If WIP `putIfAbsent` succeeded but completing
the canonical observation failed while the process remains alive, the owner
uses `getBySemanticKey` to verify the bytes and complete the fenced observation.
Process death still fails the run and leaves the operation unknown rather than
triggering automatic replay.

## Tool Contracts

### Draft and committed payloads

Published video payloads require permanent storage references, while a project
under construction has sandbox/WIP references. They are different lifecycle
types and must not be faked into one schema.

```ts
type DraftResourceRef =
  | {
      kind: "local";
      sandboxPath: string;
      blobRef?: string;
      contentDigest: string;
      contentType: string;
    }
  | {
      kind: "committed";
      resourceHandle: string;
      contentDigest?: string;
      contentType: string;
    };

type VideoPresentationDraftPayload = {
  schemaVersion: 1;
  kind: "video_presentation_draft";
  workflowVersion: "agent-skill-v2";
  builderVersion: string;
  narrationPolicy: { enabled: boolean };
  renderProfile: VideoPresentationRenderProfile;
  sourceDigest: string;
  project: VideoPresentationProject;
  slides: VideoPresentationSlide[];
  sceneModules: VideoPresentationSceneModule[];
  audioTracks: Array<VideoDraftAudioTrack & { resource: DraftResourceRef }>;
  assets: Array<VideoDraftAsset & { resource: DraftResourceRef }>;
  themeAssignments: VideoPresentationThemeAssignment[];
};

type VideoPresentationCommittedPayloadV2 = VideoPresentationProjectPayload & {
  workflowVersion: "agent-skill-v2";
  builderVersion: string;
  narrationPolicy: { enabled: boolean };
};
```

The Agent authors only `VideoPresentationDraftPayload`. It never sees or
invents `storageKey`, `storageBucket`, or `assetUrl`. A create uses only local
refs from WIP assets/narration and rejects every committed handle. For an edit,
`load_video_presentation` issues opaque `resourceHandle` values and records
their authorized storage mapping in the protected load receipt. Validation and
publication resolve a committed handle only through that same receipt; unknown,
cross-workspace, cross-version, or model-invented handles are rejected without
fetching their URL/key. An edit may mix unchanged authorized committed handles
with changed local refs. Validation freezes and verifies the draft closure.
Publication uploads the exact frozen bytes behind local refs, maps both kinds to
host-returned committed refs, validates the resulting
`VideoPresentationCommittedPayloadV2`, and commits only that published type.

`sourceDigest` retains the existing domain meaning: the normalized source
material/brief summary that grounds the presentation, not a cryptographic
content hash. Cryptographic values use names such as `sourceContentDigest` or
`projectClosureDigest`. `renderProfile` is copied verbatim from the selected
skill/user constraints so visual density, duration target, and language are not
re-inferred during publication.

`narrationPolicy.enabled: false` distinguishes an intentional silent video from
lost or partial audio. When enabled, complete one-to-one narration coverage is
required. `builderVersion` selects the versioned canonical project builder used
by validation and browser preview. The reader keeps a small builder registry;
retained legacy payloads with no field dispatch to the pinned legacy builder,
not whatever builder happens to be current after an upgrade.

The draft-to-committed mapper fills only host-owned terminal fields: semantic
request key, ready generation state, validation/projectCode verdicts, preview
summary/URL, permanent resource refs, and optional rendered-video absence. It
does not infer or rewrite project, slides, scenes, render profile, narration
policy, themes, or source digest after validation.

### `load_video_presentation`

Purpose: materialize an authorized ready artifact version into the active
sandbox for editing.

Input:

```ts
type LoadVideoPresentationInput = {
  artifactId: string;
};
```

Required behavior:

- scope the artifact lookup to the current team and workspace;
- use a capability-agnostic host port that applies content visibility policy,
  and require artifact type `video_presentation` with a current ready committed
  version;
- materialize canonical source JSON, project source files, narration, and
  referenced assets under a fresh allowed sandbox project root;
- transform the committed payload into a draft payload whose unchanged
  resources use `kind: "committed"` refs; later edits replace only changed
  resources with local refs;
- return the exact artifact/version identity and content digests;
- never mutate the ready artifact or reuse an unrelated sandbox directory;
- replay an identical successful load without creating a second working copy.

Output is a discriminated union; a successful load always identifies the exact
materialized tree:

```ts
type LoadVideoPresentationOutput =
  | {
      status: "succeeded";
      artifactId: string;
      versionId: string;
      versionNo: number;
      projectRoot: string;
      sourceJsonPath: string;
      projectClosureDigest: string;
      sourceDigest: string;
      loadReceiptId: string;
      diagnostics: [];
    }
  | {
      status: "failed" | "blocked";
      artifactId: string;
      versionId?: string;
      diagnostics: VideoDiagnostic[];
    };
```

This adapter is required because `video_presentation` is normally a
payload-only artifact with no primary downloadable attachment. The generic
`prepare_sandbox_workspace({ artifactId })` path stages primary bytes and
therefore cannot reconstruct a video project by itself.

V2 deliberately loads only the current ready version. Loading or restoring an
arbitrary historical version is a separate version-history feature and is not
part of this design.

`loadReceiptId` resolves through the host-only current-run receipt map and binds
the producing root-namespace loader tool call, artifact id, version id/no,
workspace, canonical materialized paths, and digests. It is not a
model-authored provenance value or dependent on the ToolMessage remaining in
model history.

### `generate_video_assets`

Purpose: generate and stage the bounded visual assets explicitly requested by
the current video plan, without publishing separate image artifacts.

Input:

```ts
type GenerateVideoAssetsInput = {
  projectKey: string;
  assets: Array<{
    assetSlot: string;
    prompt: string;
    slideNumbers: number[];
    aspectRatio?: string;
  }>;
};
```

Required behavior:

- validate unique asset slots, prompt/slide limits, and the per-video asset
  count before provider calls;
- use the V2 turn's pinned image target and enforced no-fallback policy;
- derive each semantic key from project key, asset slot, normalized prompt,
  options, and resolved provider/model identity;
- atomically `claimMany` the complete sorted asset-slot batch before calling
  the image provider;
- write returned bytes to the run-scoped WIP blob store before completing the
  canonical observation, then stage them into the current sandbox;
- on sandbox replacement, verify/reuse the WIP blob and restage without another
  image call;
- return exact MIME, dimensions where available, content digest, WIP reference,
  sandbox path, and sanitized diagnostics;
- never create a standalone image artifact as a hidden side effect.

Output:

```ts
type GenerateVideoAssetsOutput = {
  status: "succeeded" | "failed" | "blocked";
  assets: Array<{
    assetSlot: string;
    slideNumbers: number[];
    sandboxPath: string;
    blobRef: string;
    mimeType: string;
    width?: number;
    height?: number;
    contentDigest: string;
  }>;
  diagnostics: VideoDiagnostic[];
};
```

### `generate_video_narration`

Purpose: generate and stage narration audio in one bounded batch.

Input:

```ts
type GenerateVideoNarrationInput = {
  projectKey: string;
  language?: string;
  tracks: Array<{
    slideNumber: number;
    text: string;
  }>;
};
```

Required behavior:

- validate slide numbers and text limits before provider calls;
- use the configured TTS profile and never substitute another provider/model
  silently;
- batch at the tool boundary so an eight-slide video does not require eight
  model-visible tool calls;
- measure the returned bytes rather than estimating duration;
- put measured bytes in the host-scoped WIP blob store before completing the
  ToolMessage, then stage them under the active sandbox's allowed root;
- return paths, MIME types, measured durations, and sanitized diagnostics;
- derive per-track billing/idempotency keys from the semantic narration key and
  slide number, independent of a newly generated tool-call id;
- atomically `claimMany` the complete sorted track-key batch before the first
  TTS provider call;
- replay an identical call from its successful current-run ToolMessage and
  verified WIP blob without a new provider call or user charge, restaging into
  a replacement sandbox when necessary;
- report an unknown external side-effect outcome instead of guessing after the
  unrecoverable crash window described under Operation identity.

Output:

```ts
type GenerateVideoNarrationOutput = {
  status: "succeeded" | "failed" | "blocked";
  tracks: Array<{
    slideNumber: number;
    sandboxPath: string;
    blobRef: string;
    mimeType: string;
    durationSeconds: number;
    contentDigest: string;
  }>;
  diagnostics: VideoDiagnostic[];
};
```

### `validate_video_presentation`

Purpose: produce trusted evidence about the exact project the browser will
preview and export.

Input:

```ts
type ValidateVideoPresentationInput = {
  projectRoot: string;
  sourceJsonPath: string;
  loadReceiptId?: string;
};
```

Paths locate input; they are not the validation idempotency key. Before lookup
or execution, the validator captures a bounded immutable snapshot of the
canonical source plus every authoritative referenced file, normalizes it, and
computes `validationInputDigest`. The semantic validation key is:

```text
sha256(
  workflowVersion
  + runId
  + "validate_video_presentation"
  + validationInputDigest
  + validatorVersion
  + configuredEnvironmentIdentity
)
```

Validation executes against that same immutable draft snapshot/clean canonical
build.
Changing content at the same path necessarily produces a new key and reruns
validation. Changing a scratch-only file excluded from canonical payload and
publication does not invalidate or rerun validation.

Required checks:

1. Source JSON parses and normalizes into
   `VideoPresentationDraftPayload`; every local/committed resource ref resolves
   to verified bytes.
2. Slide numbers, scene modules, asset references, and narration tracks have
   complete and unique coverage.
3. The validator creates a fresh validation tree from the normalized draft and
   verified resource bytes using the same versioned project builder used by
   browser preview; project dependencies are available and that clean tree
   typechecks/builds.
4. Every scene renders real representative frames at the beginning, middle,
   and final valid frame.
5. Narration bytes decode, measured duration matches the manifest, and each
   narrated scene lasts long enough for speech plus tail padding.
6. The timeline contains no invalid gaps, overlaps, missing scenes, or orphaned
   narration.
7. Validation and browser preview use the same semantic payload and builder
   version. A resource resolver maps draft refs to local validation URLs and
   committed refs to artifact URLs without changing scenes/timeline/content;
   arbitrary extra files in the agent's project root are neither authoritative
   nor published.
8. Final stills are available and one final still is copied as the cover.
9. When a vision profile is configured, final stills receive visual review.

Before reading or executing, the validator canonicalizes `projectRoot` and
`sourceJsonPath`, rejects symlink/path escape, and requires both paths under the
active sandbox's allowed root.

The validation result identifies affected slide numbers and stable diagnostic
codes. It never reports `no defects` when visual review was skipped.

Deterministic runtime checks and cover generation are required. Missing vision
configuration may produce an explicit warning and `visualChecked: false`, but
does not excuse a runtime-render or cover failure.

Output is a discriminated union. A passed result cannot exist without the
required cover and trusted receipt:

```ts
type ValidateVideoPresentationOutput =
  | {
      status: "passed";
      projectClosureDigest: string;
      sourceDigest: string;
      previewImagePath: string;
      previewDigest: string;
      validatorVersion: string;
      checks: VideoValidationCheck[];
      diagnostics: [];
      warnings: string[];
      validationReceiptId: string;
    }
  | {
      status: "failed" | "blocked";
      projectClosureDigest?: string;
      sourceDigest?: string;
      checks: VideoValidationCheck[];
      diagnostics: VideoDiagnostic[];
      warnings: string[];
      previewImagePath?: never;
      previewDigest?: never;
      validationReceiptId?: never;
    };
```

`projectClosureDigest` covers every byte that can affect browser behavior or
published output: normalized draft payload, scene modules, builder version,
dependency/runtime configuration, narration bytes and metadata,
provided/generated assets, and cover bytes. The digest uses canonical relative
identities plus bytes and validator version. Files present only in the agent's
scratch project are excluded from both authority and publication.

`validationReceiptId` is an opaque reference to a host-only current-run receipt
issued before the validator returns. That trusted receipt binds workspace, run,
producing root tool call, validator version, canonical project root, project
closure digest, source digest, preview digest, checks, and issuance time. The
publisher resolves it from trusted run state and compares it with the current
files; it never trusts a model-supplied receipt body. A receipt is consumable
only inside the same active run and expires when that run becomes terminal. No
signing secret or database row is required.

The stable receipt identifier is derived by the host from the current run,
producing validation tool-call id, validator version, and closure digest. The
receipt resolver requires exactly one matching root-namespace
`validate_video_presentation` receipt in protected run state. Missing,
duplicate, malformed, cross-workspace, cross-run, or non-passed receipts are
rejected. The corresponding ToolMessage is display/history evidence, not the
receipt authority.

For an edit, the validator also resolves `loadReceiptId` from trusted current
run state and copies its artifact/version identity into the validation
observation. The publication tool obtains `expectedVersionNo` from that trusted
observation; it never accepts a model-supplied expected version. For a create,
`loadReceiptId` is absent and the receipt is bound to a new semantic request.

### `publish_video_presentation`

Purpose: commit a validated video project as a SourceWeft artifact.

Input:

```ts
type PublishVideoPresentationInput = {
  title: string;
  projectRoot: string;
  sourceJsonPath: string;
  validationReceiptId: string;
  republishArtifactId?: string;
};
```

Required behavior:

- resolve the receipt from protected current-run state and
  capture the current canonical source/assets into one immutable, bounded byte
  snapshot and recompute the complete project closure/source/preview digests
  from the exact bytes that will be published;
- reject files changed after validation;
- reject missing or stale cover evidence;
- parse and sanitize the frozen draft payload;
- upload narration and provided/generated assets from the immutable snapshot
  through the existing host storage port, then write their actual storage
  bucket/key references into a committed payload; the model never constructs
  storage keys;
- pass cover bytes as the required artifact preview and publish the completed
  payload through the current-run artifact publication port with artifact type
  `video_presentation`;
- use `republishArtifactId` only for a ready artifact the current user is
  authorized to edit;
- for republish, require it to match the artifact bound by the validation/load
  receipts and apply their `expectedVersionNo` CAS;
- rely on artifact version CAS and the active run publication fence;
- return the exact committed artifact and version identities.

Ready output is terminal for the artifact command. A failed publication is a
typed observation. Configuration, credential, permission, quota, cancellation,
and version-conflict outcomes are never reclassified as generated-content
repair tasks.

The generic `ArtifactPublisher.attachments` path is not used to infer video
asset references: today it uploads non-primary bytes without returning their
keys, while the video reader resolves narration/assets from keys inside the
payload. V2 publication explicitly uploads the captured asset bytes through the
trusted storage port, builds the final payload with returned keys, and then
commits that payload. A failed commit performs best-effort cleanup of newly
uploaded unreferenced objects; no artifact/version points at them.

### Atomic current-run publication

Extend the generic artifact host boundary so create and republish receive a
host-injected publication context derived from the current tool call:

```ts
type CurrentRunPublicationContext = {
  runId: string;
  sourceToolCallId: string;
  producer: { kind: "main" | "subagent"; subagentType?: string };
};
```

The capability/model cannot supply or override these fields. The publication
application service uses one fixed lock order and transaction:

```text
serialize semantic artifact request (tenant/type/request key advisory lock)
-> lock chat_thread_runs row
-> require run status queued/running/waiting_for_approval as appropriate
-> lock existing artifact row for republish, or establish the new artifact id
-> validate expected artifact status/version
-> for republish, authorize the current actor against the locked artifact
-> insert artifact version and update artifact ready/current version
-> persist the publisher tool's canonical ready output for sourceToolCallId
-> upsert the stable artifact_output block into assistant message metadata
-> merge the same block into run snapshot
-> commit
```

The advisory lock is scoped by team/workspace/artifact type/semantic request
key and covers reuse lookup, byte upload preparation, and commit, so concurrent
duplicate create calls cannot both pass today's non-unique `request_key`
lookup. Republish additionally uses artifact/version CAS. After commit, Redis
and NotifyHub publish best-effort wake-up events; neither channel is called
at-least-once because there is no transactional outbox or NOTIFY replay.
Transport failure cannot roll back or erase the committed publication.

Republish authorization uses the same content-mutation policy as artifact
deletion/sharing: the actor must be able to view the artifact and must be either
its creator or a content `workspace_admin`. A caller who cannot view it receives
the privacy-preserving not-found result; a visible artifact with insufficient
mutation authority returns forbidden. Authorization is evaluated again inside
the publication transaction after the artifact row lock and before the version
insert, so an earlier capability-host check cannot create a TOCTOU window.

If the process dies after this transaction but before LangGraph receives the
ToolMessage, stale-run recovery reads the committed publisher output/block and
finishes the artifact command as successful instead of marking it as a generic
failed run. It never invokes the publisher again. This narrow recovery is based
on committed domain facts and does not imply general graph resume after process
death.

## Agent Workflow

The following is a recommended path, not a host state machine:

1. Convert the user's request and selected skill options into a concise goal.
2. Use `write_todos` to track the current plan.
3. Create a storyboard, canonical source JSON, and Remotion project in
   workfiles.
4. Use `generate_video_assets` only for visual assets the storyboard actually
   calls for; use authored SVG/Remotion markup when no image model is needed.
5. Generate narration in a batch and use measured durations to size scenes.
6. Stage the canonical project/source files into the sandbox. The model does not
   receive unrestricted `execute`; the trusted validator owns build and render
   commands.
7. Validate the exact current project.
8. Read diagnostics, modify affected files or content, and validate the changed
   project.
9. Publish only with a receipt for the current digests.

The agent may change order when evidence justifies it. For example, it may
prototype one scene before generating all narration, inspect existing source
before an edit, or regenerate only one track after an audio-integrity failure.

## Recovery and Termination

V2 has no stage `maxAttempts` and does not present `attempt x/y`.

Generated-content failures return diagnostics to the agent. The agent decides
whether to patch code, rewrite content, regenerate a targeted asset/track, or
change its plan. The system permits another action only when the input digest,
relevant environment identity, or expected evidence changes.

For the five V2 video tools, an identical semantic action with unchanged input
and environment returns/reuses the canonical observation and a `NO_PROGRESS`
diagnostic where applicable. It does not call the provider, rerun trusted
validation/publication work, or charge again. The existing
`prepare_sandbox_workspace` tool remains a deterministic file-transfer action
outside this semantic cache; V2 does not expose unrestricted `execute`.

Progress is semantic, not merely a changed input or file hash. At least one of
the following must improve before the same failed goal can continue consuming
recovery budget:

- a required validation check moves from failed to passed;
- failed diagnostic count or severity decreases;
- the targeted diagnostic disappears;
- required evidence or runtime-frame coverage increases;
- narration/asset/scene coverage becomes more complete;
- the acceptance gate advances.

Changing wording or code bytes while producing the same normalized diagnostic
and evidence set is not progress. The checkpoint retains a bounded recent
failure/evidence fingerprint set for this decision; existing tool-call limits,
provider/sandbox timeouts, cancellation, and billing-balance checks remain the
final safety envelope.

Execution remains bounded by existing platform controls:

- tool-call run and thread limits;
- provider and sandbox call timeouts;
- durable run liveness and heartbeat;
- context compression;
- user cancellation;
- artifact version and run publication fences.

These are safety envelopes, not a fixed repair policy.

Failure handling:

| Failure class | V2 behavior |
| --- | --- |
| Generated schema/content invalid | Return targeted diagnostics; agent may change content |
| Scene syntax/static validation | Return affected files/slides; agent patches them |
| Scene runtime render failure | Required repair; publication remains forbidden |
| Audio decode/duration/coverage failure | Regenerate or replace affected track; no guessed duration |
| Explicit transient timeout/rate limit | Agent may retry the same configured path within existing call limits and available balance |
| Sandbox session expired/not ready | Recreate the same configured sandbox session and replay idempotently |
| Auth, quota, policy, path denial, missing credential/config | Terminal blocker; report exact safe code |
| No configured vision profile | Explicit warning with `visualChecked: false`; runtime and cover checks still required |
| Configured vision AUTH/config/quota failure | Block validation; do not silently skip configured review |
| Configured vision transient timeout | Same configured provider may recover within existing call limits and available balance |
| Invalid/unparseable vision verdict | Validation diagnostic; never claim `no defects` |
| Provider/model change required | Ask for user authority before changing behavior |
| User cancellation | Cancel active work and forbid late publication |
| Version conflict | Preserve the winning version; report conflict or same-result idempotent success |
| No progress or exhausted safety envelope | Terminal `RECOVERY_NO_PROGRESS` or budget blocker |

## Long-Running Tool Semantics

A V2 video tool runs as one ordinary tool call inside the existing durable chat
run worker:

```text
tool call -> bounded provider/sandbox work -> stream progress -> terminal observation
```

Narration batches and validation may take minutes, but they do not create a
second deliverable job or a background result. The tool does not return a
success-shaped `processing` result. If the chat worker process dies, existing
run recovery marks the run failed; V2 does not claim same-turn graph resume.
The next user-authorized run may load a committed artifact or inspect surviving
sandbox/workfile facts, but it does not silently replay an unknown provider
side effect.

The parent run's abort signal is passed to every new V2 host port. Code checks
cancellation before each costly sub-operation and before publication. Where an
upstream cannot cancel in flight, the tool ignores its late result after the
bounded call returns. Publication uses the atomic current-run fence as the
final authority.

## Realtime and Historical Consistency

The existing snapshot lost-update must be fixed before V2 cutover.

Because this design adds no revision column, all complete-snapshot writers use
one merge function under `chat_thread_runs FOR UPDATE` serialization. This
includes progress, finish, waiting-for-approval, approval updates, cancellation,
and stale-run recovery. Run snapshot and assistant message metadata are updated
in the same transaction whenever committed render blocks are involved. Once a
run is terminal, mutable progress/snapshot writers are rejected; only explicit
read-repair may restore a missing committed block from authoritative message or
artifact facts.

Merge rules are explicit:

- runner-owned scalar/tool/progress fields take the incoming current value;
- committed `artifact_output` blocks are unioned by stable block id;
- an older snapshot cannot delete a committed block;
- message metadata and run snapshot converge on the same committed block set;
- terminal output is not overwritten by later mutable artifact state.

Normal V2 progress is emitted by real tool calls and their writers. The UI
shows a dynamic activity list such as narration generation, build, validation,
targeted repair, final validation, and publication. It does not preseed eleven
stages or show attempt counters.

`publish_video_presentation` returns the committed artifact block through the
same agent run. The client upserts by stable block id. Duplicate SSE, room, and
tool-result delivery produces one card. While a run is active or recently
terminal, driver/follower clients perform bounded automatic REST reconciliation
on room heartbeat, event-gap detection, terminal transition, and a short active
poll interval. Therefore a dropped Redis/NotifyHub wake-up converges without a
manual page refresh. Reload reconstructs the same card from the assistant
message and artifact/version records.

## Editing an Existing Artifact

For an edit, the agent:

1. resolves the existing ready artifact and exact current version;
2. calls `load_video_presentation` to stage its canonical source and assets;
3. changes only the requested slides/components where practical;
4. reuses unchanged narration/assets/code by digest;
5. validates with the loader receipt so the resulting complete project and
   publication evidence remain bound to the exact base version;
6. calls `publish_video_presentation` with `republishArtifactId`.

The published version remains untouched during work. A failed edit produces no
new version and does not mark the existing artifact failed.

## File Naming

User-visible file names use the existing Unicode-safe artifact display-name
sanitizer. ASCII-safe segments remain limited to storage keys, job ids, and
sandbox-internal identifiers. A Chinese title must not collapse to
`video-presentation.video-presentation.json`.

## Capability and Command Changes

The V2 skill runtime declares the existing sandbox staging tools plus the five
video tools. The command output remains an artifact with type
`video_presentation`, and command success requires a ready result from
`publish_video_presentation`.

Before V2 binds, remove the current `video_presentation` special case in
`command-success` that requires legacy `job_id` and artifact-progress terminal
output. Command success becomes capability-owned and generic: the selected
command's declared `publisherTool`, its registered terminal-result schema, and
the returned committed artifact/version identity decide success. V2 never
fabricates a legacy job id or processing event to satisfy old checks.

Add a standard terminal-result contract to `defineAgentTool`:

```ts
type AgentToolTerminalResultSpec = {
  kind: "committed_artifact";
  artifactType: string;
};

type CommittedArtifactToolResult = {
  status: "ready";
  type: "committed_artifact_result";
  artifactType: string;
  artifactId: string;
  artifactVersionId: string;
  artifactOutputBlockId: string;
  workflowVersion: string;
};
```

The registry validates the standard schema and confirms the committed block
identity; `command-success` delegates to that registered contract. A plain or
model-forged `{status: "ready"}` is not sufficient. Legacy artifact-progress
tools retain their existing registered terminal protocol during compatibility.

The V2 command does not force the legacy `generate_video_presentation` tool.
The selected skill lets the existing root agent run the tool loop. A subagent
may be evaluated later if traces demonstrate material context isolation or
parallelism benefits; it is deliberately excluded from this design.

## Legacy Compatibility

Old messages and jobs are decoded by workflow generation:

- `legacy-worker-v1`: the existing black-box tool/pipeline and historical
  progress schema;
- `agent-skill-v2`: the new skill-driven path and dynamic tool activity.

The version is written once during turn preparation and propagated without
inference:

- `chat_thread_runs.request_json.capabilityWorkflow.version` is the active-run
  source;
- run snapshot/tool events and terminal tool output repeat the version for live
  decoding and history compatibility;
- `publish_video_presentation` writes the version into the committed artifact
  payload/version metadata;
- legacy deliverable job envelopes and results are explicitly tagged
  `legacy-worker-v1` when decoded or written after cutover.

The version is immutable for the run. A missing version is interpreted as
legacy only for records created before the cutover; new writes must always set
one. No reader guesses a version from tool names, message dates, or artifact
status.

New V2 requests never silently fall back to legacy after a failure. A rollout
flag may route newly started requests to one implementation at deployment
boundaries, but the selected implementation is fixed for the lifetime of a
request and is recorded in its tool/run metadata.

The legacy tool and worker stay available until queued legacy jobs drain and
retained history no longer needs their write-side behavior. Legacy read
compatibility remains longer. Cleanup must not delete the current payload/view
schemas or old render-block decoders while historical data still references
them.

## Code Organization

Expected V2 additions stay within existing boundaries:

```text
packages/builtin-skill-video-presentation/
  SKILL.md
  references/

packages/builtin-tool-video-presentation/src/agent-v2/
  agent-tool-defs.ts
  draft-schema.ts
  load-tool.ts
  asset-tool.ts
  narration-tool.ts
  validation-tool.ts
  publication-tool.ts
  validation-receipt.ts
  diagnostics.ts
  tool-selection.ts
```

Existing pipeline code is treated selectively:

- reuse canonical schemas, prompt/reference material, audio probing, scene
  static checks, project generation/build helpers, runtime rendering, visual
  review, preview generation, payload sanitization, and artifact view logic;
- extract the low-level install, typecheck, audio-integrity, frame-render, and
  still-collection routines behind an adapter that accepts the active sandbox
  session plus an immutable normalized draft snapshot and constructs a clean
  versioned validation tree; V2 must not call the legacy
  `runGeneratedProject` wrapper, which rebuilds and uploads a project from
  pipeline payload state;
- extract `generateImageToBytes`, `synthesizeAndMeasureAudio`,
  `validateCanonicalProjectTree`, `renderSceneSamples`, `reviewStills`,
  `buildCoverFile`, `draftToCommittedPayload`, and
  `buildSanitizedVideoPayload` seams so legacy and V2 callers share domain
  behavior without reusing legacy composite functions that upload or publish
  too early;
- move capability-specific provider/sandbox/storage behavior behind the new
  tools without creating generic host conditionals;
- keep the fixed stage definitions and host pipeline only for legacy jobs;
- do not expose artifact repositories, raw storage, or current pipeline stage
  functions directly as unrestricted model tools.

Generic changes are limited to snapshot/publication consistency and any missing
host-service port required by all consumers of the same operation. Video-only
logic remains in the video capability.

The explicit generic touch points are:

```text
packages/contracts/src/agent-tools/
  define.ts                    root_only/inheritable execution scope
  host.ts                      trusted sandbox, receipt, and WIP blob ports

apps/backend/src/modules/threads/agent/
  turn/turn-assembly.ts        exclude root-only tools from child toolsets
  turn/command-success.ts      capability-owned publisher success contract
  capability-tools/host-services.ts
                               inject sandbox/receipt/WIP/publication context
  durable/repository.ts        row-locked snapshot/message merge
  durable/runner.ts            committed-publication stale-run recovery

apps/backend/src/modules/artifacts/
  writer/repository/application publication service
                               semantic serialization + atomic run fence/output

packages/model-gateway/
  execution options/failover   enforced no-fallback policy
```

These are capability-agnostic contracts. No generic module switches on
`video_presentation` or `x-orca-*` headers.

## Rollout

1. Add characterization tests for current legacy history, ready/failed tool
   output, edit preservation, cancellation, redelivery, and card rendering.
2. Fix snapshot merge/publication consistency and verify the live card appears
   without reload.
3. Add and verify the generic root-only tool scope, trusted sandbox/observation
   ports, capability-owned command success, atomic current-run publication, and
   enforced no-fallback execution option.
4. Extract the low-level video domain seams and add the five V2 tools without
   binding them to production
   turns.
5. Rewrite the skill and capability command to bind V2 tools under an explicit
   workflow version.
6. Canary V2 for new requests while legacy jobs continue on their recorded
   path.
7. Compare quality, runtime-render pass rate, cover rate, duplicate action rate,
   latency, model/tool cost, cancellation, and edit success.
8. Make V2 the only new-request path after acceptance criteria hold.
9. Remove legacy write/orchestration code only after jobs drain and retained
   compatibility requirements permit it.

Rollback is deployment-level and explicit. A request that started as V2 remains
V2 and reports its real failure; it is never silently replayed through legacy.

## Verification

### Unit and contract tests

- All five V2 tools bind root-only and the legacy black-box tool is absent from
  the V2 command; ordinary DeepAgent built-ins may remain available.
- V2 command policy removes task/async-task, generic image generation, raw
  execute, and generic output collection while retaining deterministic sandbox
  preparation.
- General-purpose/custom child toolsets exclude root-only V2 tools even when
  the parent has the Video skill selected.
- Trusted sandbox ports enforce canonical roots, symlink rejection, byte/file
  limits, timeout, and best-effort abort semantics.
- Loading an edit enforces workspace/artifact/version identity and reconstructs
  a payload-only video artifact without mutating the ready version.
- Edit validation/publish resolves the trusted loader receipt and uses its
  version number for CAS; a newer concurrent version rejects the stale edit.
- Passed validation always contains a cover, complete closure digest,
  validator version, and receipt; failed/blocked outputs cannot carry a
  receipt.
- Narration batches validate input, measure duration, stage within allowed
  roots, and reuse identical successful observations within the active run
  without a second charge.
- Replacing the sandbox rehydrates narration from verified WIP blobs without a
  TTS replay; a missing/corrupt blob blocks instead of returning a stale path.
- Video asset generation atomically claims semantic asset slots, persists bytes
  to WIP, restages after sandbox replacement, and never emits standalone image
  artifacts.
- Validation catches a typecheck-success/runtime-failure scene such as string
  color ranges passed to numeric interpolation.
- Validation reruns when authoritative bytes change at the same paths, reuses
  an unchanged canonical snapshot, and ignores non-authoritative scratch-file
  changes.
- Every slide receives beginning/middle/end runtime sampling.
- Missing/invalid/partial narration fails required checks.
- No still or cover fails publication.
- Skipped visual review is recorded truthfully and never rendered as
  `no defects`.
- A changed file after validation invalidates the receipt.
- A forged, wrong-workspace, wrong-run, expired, or wrong-validator receipt is
  rejected, as are symlink/path escapes and audio/asset/cover replacement after
  validation.
- Context compression may remove the display ToolMessage while the bounded
  protected receipt/cache entries remain resolvable; terminal cleanup removes
  or expires those entries.
- Publication rejects cancellation, stale versions, identity mismatches, and
  unauthorized republish requests.
- Republish permits the artifact creator or a content `workspace_admin`, hides
  non-viewable artifacts as not found, and rejects a visible artifact for an
  unauthorized editor inside the locked publication transaction.
- Capability-owned command success accepts the committed V2 publisher result
  without legacy `job_id` or artifact-progress output and still rejects an
  uncommitted/processing-shaped result.
- Publication builds narration/asset storage references from host-returned
  keys, and the existing artifact view resolves every published URL.
- Validation rebuilds from the normalized draft with the same builder version
  as browser preview; scratch-only project files cannot influence a passed
  receipt or the committed artifact.
- Draft validation accepts local and committed resource refs, while publication
  transforms every local ref to a host-issued committed storage reference and
  rejects a final payload containing any local ref.
- AUTH, QUOTA, policy, path, and configuration failures are terminal and do not
  switch provider/model.
- `fallbackPolicy: "none"` prevents SourceWeft route failover for chat, image,
  vision, and TTS calls while preserving and recording an explicitly selected
  router provider's own resolved-model result.
- Identical no-progress actions do not re-execute or recharge.
- New V2 outputs contain no attempt/maxAttempts semantics.

### Integration and concurrency tests

- A normal create reaches a ready committed artifact in one agent turn.
- A validation failure is returned to the agent, a targeted repair changes the
  relevant scene, revalidation passes, and one artifact/version is published.
- A transient sandbox session failure recreates the same configured session and
  resumes without duplicate billing/output.
- Stop before publication produces no version or artifact card.
- Stop during a non-cancellable upstream command prevents subsequent actions
  and publication even if that command later returns; the UI reports that the
  run stopped without claiming physical upstream cancellation.
- Stop/publish races obey the existing run-row and artifact-version fence.
- Duplicate semantic tool delivery after a durable current-run output produces
  one narration set, one user billing settlement, one publication, and one
  artifact card;
  the provider-completed/pre-durable crash window produces an explicit unknown
  outcome rather than an unverified replay.
- TTS completion before persisted observation, validation completion before
  persisted observation, publication commit before returned ToolMessage, and
  chat-worker process death are covered by fault-injection tests. Process death
  must fail the run and must not silently resume or replay an unknown provider
  operation.
- Publication commit before ToolMessage delivery is recovered from the
  committed publisher output/block without creating another version.
- The same semantic action under a new tool-call id resolves the existing
  durable output instead of invoking the provider again.
- Two concurrent calls with the same semantic key produce one atomic owner;
  the follower waits/reuses the winner, and an owner process death fences the
  entry unknown without an upstream replay.
- Concurrent asset/narration batches with partially overlapping keys and
  opposite input order use all-or-nothing sorted `claimMany`; they neither
  deadlock nor execute a shared provider item twice, and a rejected claim leaves
  no partial ownership.
- An edit failure leaves the existing ready version unchanged.
- A stale runner snapshot cannot remove an already committed artifact block.
- Driver and follower clients receiving duplicate realtime signals render one
  card and converge with REST reload.
- Dropped Redis/NotifyHub publication wake-ups still converge automatically
  through active-run REST reconciliation without a manual refresh.
- Old failed and ready messages remain read-only and render through legacy
  compatibility.

### Real-model and browser E2E

- Chinese eight-scene science explainer with narration and a non-ASCII title;
- English product walkthrough;
- narration-disabled request;
- targeted single-slide edit;
- injected scene runtime failure repaired before publication;
- injected upload/session transient with same-path recovery;
- credential/configuration blocker with no fallback;
- user cancellation during a long validation action;
- immediate artifact-card appearance followed by reload-equivalent state;
- browser preview loads the exact committed source, audio, assets, and cover.

## Acceptance Criteria

V2 is ready for default traffic only when all of the following hold:

- new Video Presentation requests use the existing root DeepAgent and V2 tools;
- no new runtime, dedicated video subagent, database table, migration, or
  backfill was added;
- no fixed stage attempt controls V2 recovery;
- required validation is backed by runtime evidence for every scene;
- default publications always contain a valid cover;
- live and reloaded artifact cards agree without manual refresh;
- cancellation prevents late publication;
- duplicate execution is idempotent for internal billing and artifact versions,
  and external-provider uncertainty is surfaced rather than hidden;
- edits preserve the previous ready version on failure;
- provider/model changes are never silent;
- legacy history remains readable and old queued jobs retain their recorded
  implementation.

## Alternatives Rejected

### Keep the fixed pipeline and only improve retries

Rejected because it retains the behavior the redesign is meant to remove:
fixed ordering, fixed attempt counts, and a black-box tool that cannot adapt
from observations.

### Add a video-specific controller/runtime

Rejected because SourceWeft already has an agent runtime and typed tool system.
It would create two planning/state authorities and duplicate limits,
checkpointing, cancellation, and observability.

### Add a video subagent immediately

Rejected for V2 because it adds context propagation, nested progress,
cancellation, and result-bridging complexity before evidence shows the root
agent cannot handle the bounded video tool set. It remains a later optimization,
not an architectural prerequisite.

### Copy LobeHub's operation table

Rejected because the existing run, checkpoint, tool-message, sandbox-operation,
billing, and artifact stores provide the required V2 correctness without a new
schema. Fine-grained long-term operation analytics can be designed separately
if it becomes a product requirement.

### Let the agent publish directly from arbitrary shell output

Rejected because artifact type validation, preview requirements, authorization,
version CAS, idempotency, and run fencing must remain trusted host operations.
