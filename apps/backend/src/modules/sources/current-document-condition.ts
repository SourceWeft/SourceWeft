import { sql } from "drizzle-orm";
import { documents, sourceRevisions } from "@sourceweft/db";

export function currentDocumentCondition() {
  return sql`
    (
      exists (
        select 1
        from ${sourceRevisions} latest_revision
        where latest_revision.team_id = ${documents.teamId}
          and latest_revision.workspace_id = ${documents.workspaceId}
          and latest_revision.source_id = ${documents.sourceId}
          and latest_revision.id = ${documents.sourceRevisionId}
          and latest_revision.is_latest = true
          and not exists (
            select 1
            from ${documents} newer_documents
            where newer_documents.team_id = ${documents.teamId}
              and newer_documents.workspace_id = ${documents.workspaceId}
              and newer_documents.source_id = ${documents.sourceId}
              and newer_documents.source_revision_id = ${documents.sourceRevisionId}
              and (
                newer_documents.created_at > ${documents.createdAt}
                or (
                  newer_documents.created_at = ${documents.createdAt}
                  and newer_documents.id > ${documents.id}
                )
              )
          )
      )
      or (
        ${documents.sourceRevisionId} is null
        and not exists (
          select 1
          from ${sourceRevisions} any_revision
          where any_revision.team_id = ${documents.teamId}
            and any_revision.workspace_id = ${documents.workspaceId}
            and any_revision.source_id = ${documents.sourceId}
        )
        and not exists (
          select 1
          from ${documents} newer_documents
          where newer_documents.team_id = ${documents.teamId}
            and newer_documents.workspace_id = ${documents.workspaceId}
            and newer_documents.source_id = ${documents.sourceId}
            and newer_documents.source_revision_id is null
            and (
              newer_documents.created_at > ${documents.createdAt}
              or (
                newer_documents.created_at = ${documents.createdAt}
                and newer_documents.id > ${documents.id}
              )
            )
        )
      )
    )
  `;
}

// Raw-SQL helper for queries that join documents as alias `d`.
export function currentDocumentConditionForAlias(documentAlias: "d") {
  return sql.raw(`
    (
      exists (
        select 1
        from source_revisions latest_revision
        where latest_revision.team_id = ${documentAlias}.team_id
          and latest_revision.workspace_id = ${documentAlias}.workspace_id
          and latest_revision.source_id = ${documentAlias}.source_id
          and latest_revision.id = ${documentAlias}.source_revision_id
          and latest_revision.is_latest = true
          and not exists (
            select 1
            from documents newer_documents
            where newer_documents.team_id = ${documentAlias}.team_id
              and newer_documents.workspace_id = ${documentAlias}.workspace_id
              and newer_documents.source_id = ${documentAlias}.source_id
              and newer_documents.source_revision_id = ${documentAlias}.source_revision_id
              and (
                newer_documents.created_at > ${documentAlias}.created_at
                or (
                  newer_documents.created_at = ${documentAlias}.created_at
                  and newer_documents.id > ${documentAlias}.id
                )
              )
          )
      )
      or (
        ${documentAlias}.source_revision_id is null
        and not exists (
          select 1
          from source_revisions any_revision
          where any_revision.team_id = ${documentAlias}.team_id
            and any_revision.workspace_id = ${documentAlias}.workspace_id
            and any_revision.source_id = ${documentAlias}.source_id
        )
        and not exists (
          select 1
          from documents newer_documents
          where newer_documents.team_id = ${documentAlias}.team_id
            and newer_documents.workspace_id = ${documentAlias}.workspace_id
            and newer_documents.source_id = ${documentAlias}.source_id
            and newer_documents.source_revision_id is null
            and (
              newer_documents.created_at > ${documentAlias}.created_at
              or (
                newer_documents.created_at = ${documentAlias}.created_at
                and newer_documents.id > ${documentAlias}.id
              )
            )
        )
      )
    )
  `);
}
