# Video Presentation State Recovery Design

Date: 2026-08-25

## Decision

Restore the pre-regression video-presentation lifecycle without adding a table or
running a database migration. A normal create remains an in-turn operation that
streams progress and finishes only with a terminal ready, failed, cancelled, or
stalled result. A failed tool call is terminal for that turn; the agent must not
silently turn it into a background regeneration.

Keep the useful parts of the recent work:

- retryable classification for malformed model-generated storyboard, theme, and
  scene content;
- pipeline attempt, stage, error-code, and progress presentation;
- committed `artifact_output` persistence and deduplication for successful
  publications;
- live SSE progress precedence while a tool call is running;
- worker redelivery and lock fencing;
- model-provider observation work, which is independent of this fix.

Selectively restore the removed behavior:

- `generate_video_presentation` is direct-return again;
- the production tool waits for terminal generation state;
- failed artifacts are not automatically regenerated in place;
- historical `artifact` render blocks remain readable alongside the newer
  `artifact_output` blocks;
- a completed failed tool call is rendered from its persisted tool output, not
  overwritten by the artifact's later mutable snapshot.

## Constraints

- Add no table, column, migration, or backfill.
- Preserve all unrelated working-tree changes, including the in-progress model
  observation/cost work.
- Do not silently switch provider, model, command path, or test strategy.
- Historical thread loading is read-only: it must not invoke a model, enqueue a
  job, or retry generation.
- Do not claim background processing unless a future explicit async product
  contract is introduced. This change introduces no such contract.

## State Authority

The existing stores remain sufficient when their responsibilities are made
explicit:

| Situation | Authoritative state |
| --- | --- |
| Running tool call | Streamed tool progress from chat SSE |
| Completed ready call | Committed `artifact_output` plus artifact/version detail |
| Completed failed call | Persisted tool output in message metadata |
| Legacy completed processing call | One read-only artifact reconciliation |

The artifact row remains the current project/read model. Message tool output is
the immutable record of what that historical call returned. They must not be
merged as if they were the same timeline after the tool call is terminal.

## New Create Flow

1. The tool opens or reuses a pending artifact.
2. It enqueues one deliverable job.
3. It streams pipeline progress while waiting.
4. It returns a terminal ready, failed, cancelled, or stalled result.
5. `returnDirect: true` ends the agent loop on that result.
6. Command success is satisfied only by a ready terminal result.

The runtime prompt and tool description must describe this actual behavior. The
phrases `returns immediately`, `built in the background`, and `do not wait for
ready` are removed.

An abort caused by an explicit user stop is cancellation, not a processing
success. Lost worker liveness is a stalled failure, not an implicit background
handoff.

## Retry and Edit Rules

Pipeline-owned retry remains inside one tool call. Retryable validation failures
advance the existing stage attempt counter and either recover or terminate the
same generation.

Agent-owned automatic retry is removed. In particular, a failed result must not
cause the model to call `generate_video_presentation` again in the same turn.

Without a distinct generation store, a failed artifact cannot safely be mutated
back to running while preserving its historical call state. Therefore:

- automatic regeneration of a failed artifact is rejected;
- an explicit later user retry uses the normal create path and a new artifact;
- the new request may carry `retryOfArtifactId` as non-authoritative provenance;
- the old failed artifact and historical tool call stay unchanged;
- editing an already-ready artifact remains an in-place versioned edit.

Ready-artifact edits must await the deliverable job's terminal result instead of
returning an immediate processing result. The queue port may expose a bounded,
abort-aware job wait; this uses the existing BullMQ job and does not add storage.
An edit failure leaves the already-published artifact version ready.

## Historical Message Compatibility

Support both render-block generations:

- legacy `artifact` blocks identify a capability-rendered tool artifact by
  `toolCallId`;
- current `artifact_output` blocks identify a committed artifact version.

The legacy type is read compatibility only; new writes continue to use the
current protocol. When both blocks refer to the same source tool call, the
committed `artifact_output` wins so the UI does not render duplicate cards.

Restore the legacy block parser and registry-based artifact renderer. Do not add
video-specific branches to generic history loading.

Historical state selection follows these rules:

- a terminal failed tool output stays failed even if an artifact snapshot later
  changes;
- a terminal ready call may use artifact detail to enrich preview and storage
  fields;
- a legacy processing output may perform one artifact lookup to learn its final
  state;
- an artifact/workspace identity mismatch is rejected;
- changing `{ workspaceId, artifactId }` resets the local snapshot before a new
  fetch.

The known thread `6ed4f0af-5e7d-4c68-b454-b7d0c3ca3037` is a genuine historical
failure from 2026-08-04. It must remain failed, but it should be presented as a
historical storyboard-generation failure, not as a current run or background
task. Provider diagnostics are collapsed behind a concise user-facing error.

## Structured Output Errors

Keep generated-content retries but preserve the gateway error taxonomy instead
of converting every structured-output exception to a non-retryable provider
failure:

- malformed/empty structured model output and schema validation failures are
  retryable within the pipeline stage budget;
- authentication, quota, missing credential, unsupported request, and provider
  configuration failures are terminal;
- configured route attempts remain visible in sanitized diagnostics;
- a missing fallback credential is reported explicitly and never hidden by a
  silent provider substitution.

The current observed storyboard failure used DeepSeek and an OpenRouter fallback,
not OrcaRouter. OpenRouter lacked credentials. That operational configuration
problem must be reported distinctly from the final empty structured response.

## Error Presentation

Default failure copy is concise and stable, for example:

> Storyboard generation failed: the model did not return valid structured content.

The expandable diagnostic may show error code, provider/model, request ID,
attempt, content length/hash, and sanitized route-attempt summaries. Raw provider
payloads, credentials, and raw prompts remain hidden.

## Compatibility and Removal Boundary

The legacy `artifact` reader is contained in the message normalization/rendering
adapter and covered by tests. It is not emitted by new writes and does not leak
into the deliverable host. It may be removed only after the retained history no
longer contains legacy blocks; until then it is active compatibility code, not
dead code.

The normal runtime stops emitting `video_presentation_processing_result`.
Decoding that result remains only for legacy history until the same retention
condition is met.

## Verification

Automated tests must cover:

1. a new create waits and returns ready without background copy;
2. a new create returns one failed tool call after exhausted pipeline retries;
3. a failed result never triggers a second video tool call;
4. command success rejects processing and accepts ready;
5. legacy `artifact` blocks normalize and render through the capability registry;
6. `artifact_output` still renders and suppresses its duplicate legacy block;
7. completed failed history prefers persisted tool output over a mutable snapshot;
8. live running progress still prefers SSE over a frozen REST snapshot;
9. switching artifact/workspace identity resets snapshot state and rejects a
   mismatched response;
10. loading the known failed-history fixture performs no model or queue writes;
11. ready-artifact edit success waits for the new version and edit failure keeps
    the old version available;
12. structured-output validation errors retry, while credential/configuration
    failures do not;
13. the database schema and Drizzle journal have no changes from this fix.

Run the narrow package/backend/web tests first, then the relevant type checks.
Do not replace a blocked real integration with a mock without reporting the
blocker and its verification impact.

## Rollout

1. Restore direct terminal behavior and remove automatic failed regeneration.
2. Restore legacy history block reading while retaining committed output cards.
3. Correct live-versus-history state precedence and snapshot identity checks.
4. Correct structured-output retry classification and credential diagnostics.
5. Run the regression suite against both legacy and current message fixtures.
6. Verify the known failed thread is read-only and the successful historical
   fixtures still render previewable artifacts.

No database migration, data rewrite, or historical status mutation is part of
this rollout.
