# Artifact publication safety

Artifact creation with a request key uses the existing PostgreSQL transaction
lock on `(teamId, workspaceId, artifactType, requestKey)`. Generic pending/ready
creation and current-run publication share that lock and repeat the lookup
inside the transaction. Uploads happen before the transaction and never hold
database locks while waiting for object storage.

Reuse respects the destination thread's visibility and the actor's access.
Private and workspace-visible results, and different users' private results,
may legitimately share a request key. The existing non-unique index remains;
this change adds no unique constraint, table or migration. Thread visibility is
locked during creation. Artifact pre-reads recheck workspace membership and row
visibility; publication also checks visibility when updating the row.

## Results and conflicts

- `openArtifact` reuses a visible pending, running or ready artifact.
- `publishArtifact` reuses a visible ready artifact. Pending/running returns
  `ARTIFACT_STATE_CONFLICT`; failed artifacts permit a new attempt.
- Publish tools expose the committed artifact/version IDs and an explicit
  boolean `reused`. A conflict is a tool error with `recoverable=false`.
- Current-run publication rejects pending/running with `artifact_in_progress`;
  the video tool reports its existing `VIDEO_PUBLICATION_IN_PROGRESS` code.
- Republish still requires the caller's expected version to detect concurrent
  edits. A losing compare-and-swap never overwrites the winner.

The preflight can avoid uploads, but two concurrent calls may both upload before
the locked recheck. A successful `reused=true` result means no new artifact or
version was created and any objects uploaded by the losing call were cleaned
up. It does not mean no upload was attempted.

## Cleanup and uncertain commits

A definite conflict, failed compare-and-swap, upload failure or cancellation
before committing cleans only this call's attempted UUID object keys. Existing
objects and a caller-supplied stored preview are not part of that cleanup.
Cleanup failure logs the exact keys while preserving the primary conflict or
cancellation. If cleanup after reuse fails, publication reports the storage
error instead of claiming a fully cleaned reuse.

A database exception can mean that commit succeeded but its acknowledgement was
lost. The writer reads the artifact, current version and matching object
references for diagnosis, then retains the attempted objects and reports the
original error. A missing row or reference is insufficient proof of rollback:
the transaction may still be finishing, and historical primary/preview pointers
are not all stored in version JSON. There is no blind prefix deletion or new
automatic garbage collector. Retained keys need operational reconciliation.

## Rollout

All writing instances must adopt the same lock protocol before cross-instance
idempotency is guaranteed. Old instances can bypass the protocol during a
rolling deployment. Existing duplicate rows are not automatically deleted.

Concurrency regressions use isolated databases on the existing PostgreSQL
service with full backend migrations, real advisory/row locks and two-connection
barriers. Writer integration checks both distinct and shared preallocated IDs,
the returned winner, loser-object cleanup and preservation of the winner's
objects and version. No production database data is used.
