import { sql } from "drizzle-orm";

/**
 * "This document row is the current one for its source."
 *
 * A source may have many `documents` rows: one per revision, plus retries
 * within a revision. Current means either
 *
 *  - the row hangs off the source's latest revision and no newer row exists for
 *    that same revision, or
 *  - the row predates revisions entirely (`source_revision_id is null`) *and*
 *    the source still has no revisions at all, and no newer revision-less row
 *    exists.
 *
 * Newness is `created_at`, with `id` as the tie-break so two rows written in
 * the same transaction still order deterministically.
 *
 * Emitted as raw SQL against a caller-supplied reference to the outer
 * `documents` row, because the callers split two ways: Drizzle query builders
 * that leave the table unaliased, and hand-written retrieval SQL that joins it
 * as `d`. Both spellings are the same predicate — parameterising the reference
 * is what keeps them from drifting apart.
 */
function currentDocumentConditionSql(documentRef: string) {
  return sql.raw(`
    (
      exists (
        select 1
        from source_revisions latest_revision
        where latest_revision.team_id = ${documentRef}.team_id
          and latest_revision.workspace_id = ${documentRef}.workspace_id
          and latest_revision.source_id = ${documentRef}.source_id
          and latest_revision.id = ${documentRef}.source_revision_id
          and latest_revision.is_latest = true
          and not exists (
            select 1
            from documents newer_documents
            where newer_documents.team_id = ${documentRef}.team_id
              and newer_documents.workspace_id = ${documentRef}.workspace_id
              and newer_documents.source_id = ${documentRef}.source_id
              and newer_documents.source_revision_id = ${documentRef}.source_revision_id
              and (
                newer_documents.created_at > ${documentRef}.created_at
                or (
                  newer_documents.created_at = ${documentRef}.created_at
                  and newer_documents.id > ${documentRef}.id
                )
              )
          )
      )
      or (
        ${documentRef}.source_revision_id is null
        and not exists (
          select 1
          from source_revisions any_revision
          where any_revision.team_id = ${documentRef}.team_id
            and any_revision.workspace_id = ${documentRef}.workspace_id
            and any_revision.source_id = ${documentRef}.source_id
        )
        and not exists (
          select 1
          from documents newer_documents
          where newer_documents.team_id = ${documentRef}.team_id
            and newer_documents.workspace_id = ${documentRef}.workspace_id
            and newer_documents.source_id = ${documentRef}.source_id
            and newer_documents.source_revision_id is null
            and (
              newer_documents.created_at > ${documentRef}.created_at
              or (
                newer_documents.created_at = ${documentRef}.created_at
                and newer_documents.id > ${documentRef}.id
              )
            )
        )
      )
    )
  `);
}

/** For Drizzle queries that select from `documents` without aliasing it. */
export function currentDocumentCondition() {
  return currentDocumentConditionSql("documents");
}

/** For hand-written retrieval SQL that joins `documents` as `d`. */
export function currentDocumentConditionForAlias(documentAlias: "d") {
  return currentDocumentConditionSql(documentAlias);
}
