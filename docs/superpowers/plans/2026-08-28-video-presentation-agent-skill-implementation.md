# Video Presentation Agent Skill V2 Implementation Plan

Design source:
`docs/superpowers/specs/2026-08-26-video-presentation-agent-skill-design.md`

## Outcome

Move new Video Presentation requests from the fixed black-box deliverable
pipeline to SourceWeft's existing root DeepAgent skill/tool loop. New requests
will use five root-only trusted tools:

```text
load_video_presentation
generate_video_assets
generate_video_narration
validate_video_presentation
publish_video_presentation
```

The Agent owns planning and evidence-driven repair. Trusted tools own provider
I/O, sandbox execution, validation, idempotency, authorization, and atomic
publication. No new runtime, video subagent, database table, migration, or
per-request fallback is introduced.

## Working-tree safety

The repository contains extensive unstaged work, including overlapping video,
artifact, durable-run, model-gateway, and database files. Before every task:

1. Run `git status --short`.
2. Read `git diff -- <each file to be modified>`.
3. Treat every pre-existing hunk as user-owned unless this task explicitly
   supersedes it.
4. Use focused patches around the intended symbols; do not reformat or rewrite
   whole files.
5. Do not stage or commit implementation files unless the user separately asks
   for implementation commits.
6. Never include the unrelated model-observation/cost migration work in a V2
   verification or commit.

The design and this plan are documentation commits only. Implementation remains
in the current working tree until the user requests a commit strategy.

## Fallback policy

- Do not silently route a failed V2 request through
  `generate_video_presentation` legacy worker V1.
- Do not silently switch model/provider or enable gateway route failover.
- Do not replace a blocked real database/sandbox/browser verification with a
  mock and claim equivalent coverage.
- If a required host primitive cannot be implemented without a schema change,
  stop and report the exact conflict instead of adding a migration.
- A process-death crash fails the run; this plan does not invent same-turn graph
  resume.

## Task 1: Establish the regression baseline

Files to inspect, not yet modify:

- `packages/builtin-skill-video-presentation/**`
- `packages/builtin-tool-video-presentation/**`
- `apps/backend/src/modules/threads/agent/**`
- `apps/backend/src/modules/threads/durable/**`
- `apps/backend/src/modules/artifacts/**`
- `apps/web/app/dashboard/chat/**`
- `packages/contracts/src/agent-tools/**`
- `packages/contracts/src/video-presentation.ts`
- `packages/model-gateway/**`

Steps:

1. Save focused diffs for every overlapping file in the turn notes. Do not
   create a repository snapshot file.
2. Record the exact current DB-diff baseline without modifying it:

   ```bash
   git status --short -- packages/db/src/schema.ts packages/db/drizzle
   git diff --binary --output=/private/tmp/sourceweft-v2-db-baseline.diff -- packages/db/src/schema.ts packages/db/drizzle
   shasum -a 256 /private/tmp/sourceweft-v2-db-baseline.diff
   ```

   Keep the hash in turn notes and compare it again during Task 18/final review.
   Do not run `db:generate`.
3. Run current narrow characterization suites before modifying behavior:

   ```bash
   pnpm --filter @sourceweft/contracts test
   pnpm --filter @sourceweft/builtin-tool-video-presentation test
   pnpm --filter @sourceweft/backend test -- src/modules/threads/durable/repository.test.ts src/modules/artifacts/run-fence.test.ts src/worker/deliverable-host/video-presentation-pipeline.integration.test.ts
   pnpm --filter web test -- app/dashboard/chat/_components/chat-canvas 'app/dashboard/chat/[threadId]/_thread/message-groups.test.ts'
   ```

4. Record pre-existing failures verbatim. Do not switch Node version, test
   runner, database, or sandbox without stating why the failing path requires
   it.
5. Add no code in this task.

Expected result: a trustworthy baseline separates current failures from V2
regressions.

## Task 2: Make committed artifact blocks snapshot-safe

Files:

- Modify `apps/backend/src/modules/threads/durable/repository.ts`.
- Modify `apps/backend/src/modules/threads/durable/service.ts`.
- Modify `apps/backend/src/modules/threads/durable/runner.ts`.
- Modify `apps/backend/src/modules/threads/durable/run-recovery.ts` only for
  committed-publication recovery added later; first pin its current behavior in
  characterization tests.
- Add `apps/backend/src/modules/threads/durable/run-recovery.test.ts` if no
  focused recovery test module exists.
- Modify `apps/backend/src/modules/threads/durable/repository.test.ts`.
- Add or extend a focused snapshot-merge test module under
  `apps/backend/src/modules/threads/durable/`.
- Modify only the corresponding web reconciliation tests if contract behavior
  changes.

Steps:

1. Add failing tests proving an old runner snapshot cannot remove a committed
   `artifact_output` block after progress, finish, waiting approval, approval,
   cancellation, or stale-run recovery writes.
2. Add a pure, explicit snapshot merge function. Do not implement generic JSON
   deep merge.
3. Under `chat_thread_runs FOR UPDATE`, merge committed blocks by stable block
   id and update run snapshot plus assistant metadata atomically when both are
   involved.
4. Reject mutable snapshot/progress writers after terminal status.
5. Preserve existing scalar/tool/progress ownership and event offsets.
6. Add tests for duplicate blocks, conflicting ids, missing assistant message,
   and read-repair from authoritative message metadata.
7. Run:

   ```bash
   pnpm --filter @sourceweft/backend test -- src/modules/threads/durable/repository.test.ts src/modules/threads/durable/service.test.ts src/modules/threads/durable/runner.test.ts src/modules/threads/durable/run-recovery.test.ts
   pnpm --filter @sourceweft/backend check-types
   ```

Expected result: background/parallel publication cannot be erased by a stale
in-memory runner projection.

## Task 3: Add generic Agent-tool policy contracts

Files:

- Modify `packages/contracts/src/agent-tools/define.ts`.
- Modify `packages/contracts/src/agent-tools/host.ts`.
- Modify `packages/contracts/src/agent-tools/index.ts` or its current export
  barrel.
- Modify `packages/capability-contracts/src/index.ts` and capability-runtime
  projection tests for generic command tool policy.
- Modify/add contract tests under `packages/contracts/tests/`.

Steps:

1. Add failing tests for `executionScope: "root_only" | "inheritable"`, with
   existing tools defaulting to inheritable.
2. Add the standard `terminalResult: {kind: "committed_artifact",
   artifactType}` definition and `CommittedArtifactToolResult` schema.
3. Split command entry behavior from terminal success:
   - an explicit generic initial-tool policy supports `auto` or a forced tool;
   - legacy commands retain forced legacy tool selection;
   - V2 uses normal automatic tool looping while still requiring its registered
     publisher result for success.
4. Add a generic command tool allow/deny policy contract. Backend code consumes
   capability-declared ids; it must not branch on `video_presentation`.
5. Add structural host ports from the approved design:
   - authorized current artifact-version reader;
   - trusted sandbox ensure/upload/list/download/execute/capture operations;
   - protected current-run receipt service;
   - atomic semantic-operation `claimMany/complete/markUnknown` service;
   - run-scoped WIP blob put/get/delete service.
6. Keep every identity field host-injected. No capability input may accept
   team/workspace/run ids, object keys, or raw authorization decisions.
7. Pin bounded payload/file/cache limits in contracts or shared configuration;
   do not leave unbounded arrays/bytes.
8. Run:

   ```bash
   pnpm --filter @sourceweft/contracts test
   pnpm --filter @sourceweft/contracts check-types
   ```

Expected result: the new V2 tool definitions can express all trusted operations
without a video string in generic contracts.

## Task 4: Enforce root-only tools and V2 command policy

Files:

- Modify `apps/backend/src/modules/threads/agent/turn/turn-assembly.ts`.
- Modify `apps/backend/src/modules/threads/agent/turn/tool-utils.ts` if tool
  filtering belongs there.
- Modify `apps/backend/src/modules/threads/agent/middleware/command-tool-choice.ts`.
- Modify relevant tests in `turn-assembly`, `subagent-namespace`, and command
  workflow suites.

Steps:

1. Add failing tests proving root-only tools are bound to the parent model and
   absent from general-purpose/custom child toolsets.
2. Implement capability-agnostic scope filtering before subagent construction.
3. Implement the generic capability-declared command policy from Task 3; do not
   add a video id/type branch in backend middleware.
4. Add tests proving an `initialToolPolicy: auto` command is not forced to call
   its terminal publisher first, while a legacy forced-tool command preserves
   current behavior.
5. Add V2 command policy fixture tests proving the turn excludes:
   - `task` and all async-task tools;
   - legacy `generate_video_presentation`;
   - generic `generate_image`;
   - raw `execute`;
   - generic `collect_sandbox_outputs`.
6. Preserve `write_todos`, bounded filesystem tools, deterministic
   `prepare_sandbox_workspace`, and the five V2 tools.
7. Ensure non-V2 turns retain their current tool surfaces.
8. Run the focused thread-agent tests and backend typecheck.

Expected result: V2 authoring and trusted side effects cannot move into an
implicit child Agent or unrestricted generic tool.

## Task 5: Implement protected receipt and semantic operation state

Files:

- Modify `apps/backend/src/modules/threads/agent/capability-tools/host-services.ts`.
- Add a focused module under
  `apps/backend/src/modules/threads/agent/capability-tools/` for protected run
  state operations.
- Modify durable repository/service only through the row-locked snapshot merge
  boundary introduced in Task 2.
- Add focused unit and concurrency tests.
- Modify `apps/backend/src/modules/threads/durable/run-recovery.ts` and its
  tests so stale owner claims are atomically fenced unknown when a run dies.

Steps:

1. Store `trustedReceipts` and semantic-operation cache in host-only bounded run
   snapshot channels excluded from model prompt construction.
2. Implement `claimMany` as one row-locked, sorted-unique, all-or-nothing
   operation:
   - completed keys return reuse;
   - all free keys are fenced to one owner;
   - any foreign in-progress or unknown key leaves no partial claims;
   - only claim tokens may complete/mark unknown.
3. Make active-run cache entries non-evictable. Reject before side effects when
   capacity reaches the existing run tool-call bound.
4. Implement receipt issue/resolve with workspace/run/root-scope/tool/schema
   binding. Context compression must not remove receipt authority.
5. On stale-run failure, mark every in-progress claim owned by that run unknown
   before terminal cleanup; never free it for automatic replay.
6. Use a real Postgres database with two independent connections for
   claimMany/owner-fence concurrency tests; pure mocks are insufficient.
7. Add tests for same-key concurrency, overlapping reverse-order batches,
   owner death, stale fence token, duplicate ToolMessages, compression, and
   terminal cleanup.
8. Run focused backend tests and typecheck.

Expected result: parallel model tool calls cannot duplicate external image/TTS
side effects or forge validation/load receipts.

## Task 6: Implement the run-scoped WIP blob port

Files:

- Modify the artifact storage contract/adapter only where a generic scoped WIP
  API belongs.
- Modify `apps/backend/src/modules/threads/agent/capability-tools/host-services.ts`.
- Add focused storage and host-service tests.

Steps:

1. Add host-built team/workspace/run/semantic-key object layout. Capabilities
   receive only opaque blob refs.
2. Implement `putIfAbsent`, `getVerified`, `getBySemanticKey`, and scoped
   best-effort cleanup/TTL using existing object storage.
3. Verify content digests on every read and reject cross-run/workspace refs.
4. Cover provider-success -> blob-write -> observation-complete crash windows.
   Process death marks the run/claim unknown; it does not replay the provider.
5. Add tests for sandbox replacement restaging, corrupt/missing bytes,
   concurrent put, and cleanup.
6. Add at least one configured S3-compatible integration test proving
   conditional put/same semantic key convergence. If credentials/network are
   unavailable, request access and report this test as blocked; do not replace
   it silently with an in-memory mock.

Expected result: image/audio bytes survive sandbox replacement inside an active
run without a new provider call or table.

## Task 7: Expand trusted sandbox host services

Files:

- Modify `packages/builtin-tool-sandbox` runtime/service contracts as needed.
- Modify `apps/backend/src/modules/threads/agent/capability-tools/host-services.ts`.
- Modify/add sandbox runtime tests.

Steps:

1. Expose trusted current-session ensure, binary upload, bounded list/download,
   command execution, and immutable tree capture through the Task 3 port.
2. Canonicalize roots and reject symlink/path escape before reading/executing.
3. Enforce max files/bytes and existing command timeout.
4. Thread `AbortSignal` into providers that support cancellation.
5. For providers without physical cancellation, discard late output and keep
   publication fenced; test truthful cancellation presentation.
6. Preserve the user-facing sandbox `execute` tool behavior outside V2.

Expected result: V2 tools can safely operate on the active sandbox without
receiving raw runtime/repository authority.

## Task 8: Enforce model-gateway no-fallback execution

Files:

- Modify `packages/model-gateway/src/types.ts` and the narrow execution option
  path.
- Modify `packages/model-gateway/src/endpoints/failover.ts` and affected bridge
  call sites.
- Extend official adapter/gateway tests.
- Modify backend model-call adapters only to propagate the generic option.

Steps:

1. Inspect and preserve all existing OrcaRouter/provider-observation dirty
   hunks before editing.
2. Add a failing test showing `fallbackPolicy: "none"` calls exactly one
   SourceWeft route target on a failoverable error.
3. Implement the option in the shared failover runner; do not add provider-name
   checks.
4. Verify an explicitly selected router provider may return a different
   resolved upstream model while SourceWeft does not try another configured
   route candidate.
5. Propagate the option to V2 chat/image/vision/TTS target resolution.
6. Run model-gateway package tests and typecheck.

Expected result: V2 never silently changes SourceWeft provider/model routes and
still records a router provider's actual resolved model.

## Task 9: Add canonical draft/committed video contracts

Files:

- Modify `packages/contracts/src/video-presentation.ts`.
- Modify/add video-presentation contract tests.
- Modify browser/project builder dispatch contracts where versioning belongs.

Steps:

1. Add `VideoPresentationDraftPayload` with:
   - workflow/builder version;
   - narration policy;
   - full render profile and semantic source digest;
   - local WIP refs and opaque authorized committed handles.
2. Add committed V2 payload fields while preserving legacy schema reads.
3. Add a builder registry keyed by `builderVersion`; missing legacy fields map
   only to the pinned legacy builder.
4. Ensure create drafts reject committed handles. Edit handles resolve only
   against the trusted load receipt's authorized resource map.
5. Add tests for silent-video vs missing-audio distinction, mixed edit refs,
   unknown handles, builder dispatch, and no model-authored storage keys.
6. Run contracts tests/typecheck.

Expected result: validation works on local draft resources and publication
produces the exact permanent payload the browser later uses.

## Task 10: Refactor reusable video domain seams

Files:

- Modify focused modules under
  `packages/builtin-tool-video-presentation/src/pipeline/`.
- Add domain modules outside the legacy stage switch where appropriate.
- Preserve legacy integration tests.

Steps:

1. Add characterization tests before extracting behavior from legacy composite
   functions.
2. Extract pure/narrow seams:
   - `generateImageToBytes`;
   - `synthesizeAndMeasureAudio`;
   - `validateCanonicalProjectTree`;
   - `renderSceneSamples`;
   - `reviewStills`;
   - `buildCoverFile`;
   - `draftToCommittedPayload`;
   - `buildSanitizedVideoPayload`.
3. Do not call legacy `runGeneratedProject` from V2 validation; it rebuilds from
   worker payload instead of the Agent's immutable draft snapshot.
4. Do not call legacy audio/cover composite functions that upload or publish
   before V2 publication.
5. Keep legacy fixed-stage behavior byte-compatible.
6. Run the complete video package tests after every extraction group.

Expected result: V2 and legacy share domain truth without sharing orchestration
or premature side effects.

## Task 11: Implement `load_video_presentation`

Files:

- Add `packages/builtin-tool-video-presentation/src/agent-v2/load-tool.ts`.
- Add shared V2 diagnostics/selection modules and tests.
- Extend artifact host services with authorized current-version reading.

Steps:

1. Add failing tests for workspace visibility, current ready version, wrong
   type, private artifact, and payload-only reconstruction.
2. Read only the authorized current version; historical arbitrary version load
   is out of scope.
3. Convert committed resources to opaque handles bound in a protected load
   receipt; never expose storage keys/URLs as editable input.
4. Materialize the draft/project into a fresh allowed sandbox root.
5. Use semantic claim/cache and return a passed union containing versionNo,
   paths, digests, and `loadReceiptId`.
6. Run video/backend focused tests and typechecks.

Expected result: an edit begins from a trusted exact version without mutating
the published artifact.

## Task 12: Implement `generate_video_assets` and narration

Files:

- Add `agent-v2/asset-tool.ts` and `agent-v2/narration-tool.ts`.
- Add agent-tool definitions/schemas and tests.

Steps:

1. Add failing batch input, output, claimMany, WIP, billing, and sandbox
   restaging tests.
2. Pin image/TTS targets with no SourceWeft fallback.
3. Claim all sorted batch semantic keys before the first provider call.
4. Persist bytes to WIP before completing observations; return opaque refs,
   measured audio durations, MIME/dimensions, paths, and digests.
5. Do not create standalone image artifacts.
6. Return typed terminal blockers for auth/quota/config/policy and evidence for
   generated-content failures.
7. Run video/model-gateway/backend focused tests.

Expected result: asset/audio generation is bounded, batch-efficient,
idempotent within the active run, and restageable after sandbox replacement.

## Task 13: Implement trusted validation and receipts

Files:

- Add `agent-v2/validation-tool.ts`, `validation-receipt.ts`, and tests.
- Modify the versioned canonical project builder and browser reader tests.

Steps:

1. Capture one immutable bounded draft/resource snapshot and compute
   `validationInputDigest` before semantic cache lookup.
2. Call `claimMany([validationSemanticKey])` before any sandbox or vision side
   effect. Handle execute/reuse/wait/unknown explicitly.
3. Resolve local WIP refs and authorized committed handles; reject path escape,
   missing/corrupt bytes, and untrusted handles.
4. Build a fresh canonical tree with the recorded builder version.
5. Typecheck/build and render beginning/middle/end frames for every scene.
6. Validate audio decode/duration/coverage and timeline invariants.
7. Produce final stills/required cover and run configured vision review with
   the approved error matrix.
8. Issue a protected passed receipt only when required checks and cover pass,
   then fenced-complete the canonical observation. Mark deterministic failure
   or unknown through the same claim protocol.
9. Add tests for concurrent identical validation, reuse without a second
   vision call, receipt-issued/complete failure reconciliation, same-path
   changed bytes, scratch-only changes, and forged/stale
   receipts, configured vision failures, and the real interpolate-color runtime
   regression.

Expected result: the receipt proves the same semantic project/bytes/builder the
browser will use.

## Task 14: Implement atomic current-run publication

Files:

- Modify `packages/contracts/src/artifact-write.ts` only as required for a
  host-injected publication context.
- Modify `apps/backend/src/modules/artifacts/writer.ts` and repository/
  application-service boundaries.
- Modify `apps/backend/src/modules/threads/agent/capability-tools/host-services.ts`.
- Modify `apps/backend/src/modules/threads/durable/run-recovery.ts`,
  `runner.ts`, and their focused tests for committed-publication recovery.
- Add `agent-v2/publication-tool.ts` and tests.
- Extend run-fence, writer, repository, and publication concurrency tests.

Steps:

1. Add failing tests for create/republish cancellation races, concurrent
   duplicate request keys, stale edit versions, and unauthorized republish.
2. Serialize semantic create requests with tenant/type/request-key advisory
   locking without a new index/table.
3. Capture immutable publish bytes, verify the protected validation/load
   receipts, upload local resources, and build real payload storage refs.
4. Inside the fixed lock-order transaction:
   - recheck active run;
   - recheck creator/workspace-admin mutation policy;
   - enforce artifact/version CAS;
   - commit version/ready row;
   - persist canonical publisher output;
   - upsert message/run artifact block.
5. Make post-commit notification best-effort and idempotent.
6. Require repository/application methods participating in publication to use
   one injected transaction handle; forbid fallback to global `db` or nested
   independent transactions.
7. Add transaction failpoints after version insert, canonical tool output, and
   message block write. Each injected error must roll back artifact/version,
   publisher output, message block, and run projection together. Pre-uploaded
   blobs may only remain as cleanup-eligible orphans.
8. Add a post-commit notification failure test proving committed facts remain.
9. Recover commit-before-ToolMessage process death from committed publisher
   facts without a second version.
10. Add cleanup tests for unreferenced pre-upload objects after rejected commit.

Expected result: one committed version, one terminal output, and one card are
the same transactionally fenced fact.

## Task 15: Make command success capability-owned

Files:

- Modify `apps/backend/src/modules/threads/agent/turn/command-success.ts`.
- Modify its tests and relevant agent-tool registry tests.

Steps:

1. Add failing V2 tests proving committed publisher output succeeds without
   legacy `job_id`/artifact-progress output.
2. Delegate success to the registered standard committed-artifact terminal
   contract.
3. Keep legacy progress-protocol success for legacy tools.
4. Reject forged/plain ready, processing, wrong artifact type, and missing
   committed block identities.

Expected result: no video-specific command-success field branch remains.

## Task 16: Rewrite and bind the Video Presentation skill V2

Files:

- Modify `packages/builtin-skill-video-presentation/SKILL.md`.
- Modify its references, README, and `sourceweft.capability.json`.
- Modify `packages/builtin-tool-video-presentation` definitions, manifest,
  exports, prompt/selection modules, and tests.
- Modify turn preflight/version propagation tests.

Steps:

1. Rewrite the root skill as progressive guidance modeled on PPT Deck/Remotion
   skills, not a fixed numbered state machine.
2. Declare deterministic staging plus the five root-only V2 tools, generic
   deny policy, and `initialToolPolicy: auto`; legacy V1 retains forced old-tool
   policy.
3. Add workflow version once at run preparation and propagate it through run,
   tool events/results, message metadata, and committed payload/version.
4. Set publisher tool and terminal-result contract to
   `publish_video_presentation`.
5. Ensure V2 never binds/calls legacy tool or silently falls back.
6. Preserve old manifest/tool registrations required to decode legacy history
   and drain queued jobs.
7. Test create, edit, silent narration, style/language options, and exact tool
   policy.

Expected result: `/video` and selected Video skill run through the existing root
DeepAgent tool loop with no fixed attempt UI.

## Task 17: Update dynamic progress and historical compatibility

Files:

- Modify only generic chat-canvas/tool-card/reasoning-trace modules needed to
  group V2 activity.
- Preserve legacy artifact block and progress renderers.
- Extend driver/follower/reload tests.

Steps:

1. Render real V2 tool activity rather than preseeded pipeline stages.
2. Upsert committed card by stable block id across agent SSE, room wake-up, and
   tool result.
3. Add bounded active/recent-terminal REST reconciliation so dropped Redis/
   NotifyHub wake-ups converge without manual refresh.
4. Preserve terminal failed historical output over mutable artifact snapshots.
5. Test live/reload equivalence, duplicate events, event gaps, identity switch,
   and old legacy fixtures.

Expected result: the card appears live, remains identical after reload, and old
threads remain truthful.

## Task 18: Integrated Agent-loop and fault verification

Automated scenarios:

1. Normal V2 create publishes once in one Agent turn.
2. Scene runtime failure returns a diagnostic; Agent edits only the affected
   scene, revalidates, then publishes.
3. Silent narration is intentional and distinguishable from missing audio.
4. Edit loads the current version and failed edit preserves it.
5. Same semantic calls with new tool ids reuse canonical observations.
6. Overlapping image/narration batches do not deadlock or duplicate providers.
7. Sandbox replacement rehydrates WIP bytes.
8. Config/auth/quota/path errors stop without provider fallback.
9. Stop during cancellable and non-cancellable calls prevents late publish.
10. Snapshot/event loss still converges automatically.
11. Process death follows the explicitly supported outcomes.
12. No new DB schema/journal diff is produced by V2.

Run package tests and typechecks in dependency order, then broader checks:

```bash
pnpm --filter @sourceweft/contracts test
pnpm --filter @sourceweft/contracts check-types
pnpm --filter @sourceweft/capability-contracts test
pnpm --filter @sourceweft/capability-contracts check-types
pnpm --filter @sourceweft/capability-runtime test
pnpm --filter @sourceweft/capability-runtime check-types
pnpm --filter @sourceweft/model-gateway test
pnpm --filter @sourceweft/model-gateway check-types
pnpm --filter @sourceweft/builtin-tool-sandbox test
pnpm --filter @sourceweft/builtin-tool-sandbox check-types
pnpm --filter @sourceweft/builtin-tool-video-presentation test
pnpm --filter @sourceweft/builtin-tool-video-presentation check-types
pnpm --filter @sourceweft/builtin-skill-video-presentation test
pnpm --filter @sourceweft/builtin-skill-video-presentation check-types
pnpm --filter @sourceweft/agent-tool-registry test
pnpm --filter @sourceweft/agent-tool-registry check-types
pnpm --filter @sourceweft/backend test
pnpm --filter @sourceweft/backend check-types
pnpm --filter web test
pnpm --filter web check-types
pnpm lint
```

If the complete repository suite is blocked by unrelated dirty observation or
migration work, report exact failures and run the unchanged baseline comparison.

## Task 19: Real browser and real-provider acceptance

Use the existing configured providers; do not substitute mocks for this task.

Before running, document the reproducible harness in turn notes:

1. Start the approved backend/web/worker development commands without changing
   provider or test strategy.
2. Use the repository's existing seeded test workspace/user when available; if
   no reusable browser harness exists, label this as supervised manual browser
   acceptance rather than automated E2E.
3. Record thread/run/artifact ids, screenshots, browser console errors, backend
   log span ids, and exact commands.
4. Use browser network inspection to verify immediate/follower/reload event
   convergence.

Scenarios:

- Chinese eight-scene science explainer with narration/non-ASCII title;
- English product walkthrough;
- narration-disabled video;
- targeted single-slide edit;
- injected runtime scene error repaired before publication;
- sandbox upload/session transient;
- credential/configuration blocker;
- cancellation during validation;
- immediate card on driver and follower, followed by reload equivalence.

Verify:

- every scene's representative frames;
- measured narration and timeline;
- cover exists;
- browser preview uses committed builder/payload/assets;
- source JSON and file name are correct;
- no background success, fixed attempt counter, silent provider switch,
  duplicate charge, artifact, version, or card.

If credentials, sandbox, or browser access is unavailable, request the exact
approval/access. Do not replace the blocked scenario silently.

## Task 20: Canary, default switch, and legacy cleanup

1. Keep workflow version immutable per run.
2. Canary V2 for new requests only; measure quality, validation pass rate,
   cover rate, repair loops, cost, latency, cancellation, and duplicates.
3. Do not retry a failed V2 request through legacy.
4. After acceptance criteria hold, make V2 the only new-request path.
5. Keep legacy worker/job decoding until queued jobs drain.
6. Keep historical read compatibility for the retention lifetime.
7. Remove legacy write/orchestration code only in a separately reviewed cleanup
   after proving no active caller remains.

## Final review checklist

- Inspect every touched diff and preserve pre-existing hunks.
- Run `git diff --check`.
- Confirm no V2 implementation commit contains DB schema/migration/journal
  files.
- Compare the Task 1 DB dirty-diff hash byte-for-byte; any change fails the
  no-migration gate. Do not run schema generation.
- Search generic changes for `video_presentation`, provider ids, and `x-orca-*`;
  generic contracts must remain capability/provider agnostic.
- Confirm V2 tools are root-only and delegation/raw execute/generic image are
  absent.
- Confirm the committed payload contains narration policy and builder version,
  with no local refs or model-authored storage keys.
- Confirm publication result, artifact version, message block, and run snapshot
  share exact ids.
- Report tests, real-provider evidence, measured costs/latency, remaining
  compatibility code, and any explicit blockers.
