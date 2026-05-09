import { sql } from "drizzle-orm";
import { db } from "../../../shared/database";
import { toPostgresTextArray } from "../sql";
import { buildVirtualSourceTree } from "./paths";
import type {
  VirtualFsDocument,
  VirtualFsGrepCandidate,
  VirtualFsSource,
  VirtualFsChunk,
} from "./types";

const MAX_GREP_TERM_TOP_K = 120;
const MIN_GREP_TERM_TOP_K = 50;

function sourceIdsClause(sourceIds: string[] | undefined) {
  if (!sourceIds || sourceIds.length === 0) {
    return sql`and false`;
  }
  return sql`and s.id = any(${toPostgresTextArray(sourceIds)}::text[])`;
}

export async function listVirtualFsSources(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
  limit?: number;
}): Promise<VirtualFsSource[]> {
  const rows = await db.execute<{
    source_id: string;
    source_type: VirtualFsSource["sourceType"];
    parent_source_id: string | null;
    title: string;
    file_name: string | null;
    mime_type: string | null;
    size_bytes: number | string | null;
    updated_at: Date;
    chunk_count: number | string;
  }>(sql`
    select
      s.id as source_id,
      s.source_type,
      s.parent_source_id,
      s.title,
      nullif(s.metadata_json->>'fileName', '') as file_name,
      s.mime_type,
      s.size_bytes,
      s.updated_at,
      count(c.id)::int as chunk_count
    from sources s
    left join documents d
      on d.source_id = s.id
     and d.team_id = s.team_id
     and d.workspace_id = s.workspace_id
     and not exists (
       select 1
       from documents newer_documents
       where newer_documents.team_id = d.team_id
         and newer_documents.workspace_id = d.workspace_id
         and newer_documents.source_id = d.source_id
         and (
           newer_documents.created_at > d.created_at
           or (
             newer_documents.created_at = d.created_at
             and newer_documents.id > d.id
           )
         )
     )
    left join chunks c
      on c.document_id = d.id
     and c.team_id = s.team_id
     and c.workspace_id = s.workspace_id
    where s.team_id = ${input.teamId}
      and s.workspace_id = ${input.workspaceId}
      and s.status = 'indexed'
      ${sourceIdsClause(input.sourceIds)}
    group by s.id
    order by s.parent_source_id nulls first, s.source_type asc, s.title asc, s.updated_at desc
    limit ${input.limit ?? 500}
  `);

  return buildVirtualSourceTree(
    rows.rows.map((row) => ({
      sourceId: row.source_id,
      sourceType: row.source_type,
      parentSourceId: row.parent_source_id,
      title: row.title,
      fileName: row.file_name,
      chunkCount: Number(row.chunk_count),
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      mimeType: row.mime_type,
      updatedAt: row.updated_at,
    })),
  );
}

export async function getVirtualFsDocument(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
}): Promise<VirtualFsDocument | null> {
  const rows = await db.execute<{
    source_id: string;
    source_title: string;
    source_file_name: string | null;
    document_id: string | null;
    document_content: string | null;
    source_content: string | null;
    updated_at: Date | null;
  }>(sql`
    select
      s.id as source_id,
      s.title as source_title,
      nullif(s.metadata_json->>'fileName', '') as source_file_name,
      d.id as document_id,
      d.content_text as document_content,
      s.content_text as source_content,
      coalesce(d.updated_at, s.updated_at) as updated_at
    from sources s
    left join documents d
      on d.source_id = s.id
     and d.team_id = s.team_id
     and d.workspace_id = s.workspace_id
     and not exists (
       select 1
       from documents newer_documents
       where newer_documents.team_id = d.team_id
         and newer_documents.workspace_id = d.workspace_id
         and newer_documents.source_id = d.source_id
         and (
           newer_documents.created_at > d.created_at
           or (
             newer_documents.created_at = d.created_at
             and newer_documents.id > d.id
           )
         )
     )
    where s.team_id = ${input.teamId}
      and s.workspace_id = ${input.workspaceId}
      and s.status = 'indexed'
      and s.id = ${input.sourceId}
    order by d.updated_at desc nulls last
    limit 1
  `);

  const row = rows.rows[0];
  if (!row) {
    return null;
  }

  return {
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceFileName: row.source_file_name,
    documentId: row.document_id,
    content: row.document_content || row.source_content || null,
    updatedAt: row.updated_at,
  };
}

export async function listVirtualFsChunks(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  limit?: number;
  offset?: number;
}): Promise<VirtualFsChunk[]> {
  const rows = await db.execute<{
    source_id: string;
    source_title: string;
    source_file_name: string | null;
    document_id: string;
    chunk_id: string;
    chunk_no: number;
    content: string;
    start_offset: number | null;
    end_offset: number | null;
    heading_path: string | null;
    language: string | null;
  }>(sql`
    select
      c.source_id,
      s.title as source_title,
      nullif(s.metadata_json->>'fileName', '') as source_file_name,
      c.document_id,
      c.id as chunk_id,
      c.chunk_no,
      c.content,
      c.start_offset,
      c.end_offset,
      c.heading_path,
      c.language
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.team_id = ${input.teamId}
      and c.workspace_id = ${input.workspaceId}
      and c.source_id = ${input.sourceId}
      and s.status = 'indexed'
      and not exists (
        select 1
        from documents newer_documents
        where newer_documents.team_id = d.team_id
          and newer_documents.workspace_id = d.workspace_id
          and newer_documents.source_id = d.source_id
          and (
            newer_documents.created_at > d.created_at
            or (
              newer_documents.created_at = d.created_at
              and newer_documents.id > d.id
            )
          )
      )
    order by c.chunk_no asc
    limit ${input.limit ?? 6}
    offset ${input.offset ?? 0}
  `);

  return rows.rows.map((row) => ({
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceFileName: row.source_file_name,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    chunkNo: Number(row.chunk_no),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    headingPath: row.heading_path,
    language: row.language,
  }));
}

export async function listVirtualFsChunksForSpan(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  startOffset: number;
  endOffset: number;
  limit?: number;
}): Promise<VirtualFsChunk[]> {
  const rows = await db.execute<{
    source_id: string;
    source_title: string;
    source_file_name: string | null;
    document_id: string;
    chunk_id: string;
    chunk_no: number;
    content: string;
    start_offset: number | null;
    end_offset: number | null;
    heading_path: string | null;
    language: string | null;
    overlap_chars: number | string;
  }>(sql`
    select
      c.source_id,
      s.title as source_title,
      nullif(s.metadata_json->>'fileName', '') as source_file_name,
      c.document_id,
      c.id as chunk_id,
      c.chunk_no,
      c.content,
      c.start_offset,
      c.end_offset,
      c.heading_path,
      c.language,
      greatest(
        0,
        least(coalesce(c.end_offset, 0), ${input.endOffset}) -
        greatest(coalesce(c.start_offset, 0), ${input.startOffset})
      ) as overlap_chars
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.team_id = ${input.teamId}
      and c.workspace_id = ${input.workspaceId}
      and c.source_id = ${input.sourceId}
      and s.status = 'indexed'
      and c.start_offset is not null
      and c.end_offset is not null
      and c.start_offset < ${input.endOffset}
      and c.end_offset > ${input.startOffset}
      and not exists (
        select 1
        from documents newer_documents
        where newer_documents.team_id = d.team_id
          and newer_documents.workspace_id = d.workspace_id
          and newer_documents.source_id = d.source_id
          and (
            newer_documents.created_at > d.created_at
            or (
              newer_documents.created_at = d.created_at
              and newer_documents.id > d.id
            )
          )
      )
    order by overlap_chars desc, c.chunk_no asc
    limit ${input.limit ?? 50}
  `);

  return rows.rows.map((row) => ({
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceFileName: row.source_file_name,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    chunkNo: Number(row.chunk_no),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    headingPath: row.heading_path,
    language: row.language,
  }));
}

export async function getVirtualFsChunk(input: {
  teamId: string;
  workspaceId: string;
  sourceId: string;
  chunkNo: number;
}): Promise<VirtualFsChunk | null> {
  const rows = await db.execute<{
    source_id: string;
    source_title: string;
    source_file_name: string | null;
    document_id: string;
    chunk_id: string;
    chunk_no: number;
    content: string;
    start_offset: number | null;
    end_offset: number | null;
    heading_path: string | null;
    language: string | null;
  }>(sql`
    select
      c.source_id,
      s.title as source_title,
      nullif(s.metadata_json->>'fileName', '') as source_file_name,
      c.document_id,
      c.id as chunk_id,
      c.chunk_no,
      c.content,
      c.start_offset,
      c.end_offset,
      c.heading_path,
      c.language
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.team_id = ${input.teamId}
      and c.workspace_id = ${input.workspaceId}
      and c.source_id = ${input.sourceId}
      and c.chunk_no = ${input.chunkNo}
      and s.status = 'indexed'
      and not exists (
        select 1
        from documents newer_documents
        where newer_documents.team_id = d.team_id
          and newer_documents.workspace_id = d.workspace_id
          and newer_documents.source_id = d.source_id
          and (
            newer_documents.created_at > d.created_at
            or (
              newer_documents.created_at = d.created_at
              and newer_documents.id > d.id
            )
          )
      )
    limit 1
  `);

  const row = rows.rows[0];
  if (!row) {
    return null;
  }

  return {
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceFileName: row.source_file_name,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    chunkNo: Number(row.chunk_no),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    headingPath: row.heading_path,
    language: row.language,
  };
}

export async function grepVirtualFsChunks(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
  queryText: string;
  topK: number;
}): Promise<VirtualFsGrepCandidate[]> {
  const rows = await db.execute<{
    source_id: string;
    source_title: string;
    source_file_name: string | null;
    document_id: string;
    chunk_id: string;
    chunk_no: number;
    content: string;
    start_offset: number | null;
    end_offset: number | null;
    heading_path: string | null;
    language: string | null;
    score: number | string;
  }>(sql`
    select
      c.source_id,
      s.title as source_title,
      nullif(s.metadata_json->>'fileName', '') as source_file_name,
      c.document_id,
      c.id as chunk_id,
      c.chunk_no,
      c.content,
      c.start_offset,
      c.end_offset,
      c.heading_path,
      c.language,
      pdb.score(c.id) as score
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.team_id = ${input.teamId}
      and c.workspace_id = ${input.workspaceId}
      and s.status = 'indexed'
      and c.content ||| ${input.queryText}
      ${sourceIdsClause(input.sourceIds)}
      and not exists (
        select 1
        from documents newer_documents
        where newer_documents.team_id = d.team_id
          and newer_documents.workspace_id = d.workspace_id
          and newer_documents.source_id = d.source_id
          and (
            newer_documents.created_at > d.created_at
            or (
              newer_documents.created_at = d.created_at
              and newer_documents.id > d.id
            )
          )
      )
    order by pdb.score(c.id) desc
    limit ${input.topK}
  `);

  return rows.rows.map((row) => ({
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceFileName: row.source_file_name,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    chunkNo: Number(row.chunk_no),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    headingPath: row.heading_path,
    language: row.language,
    score: Number(row.score),
  }));
}

export function calculatePerTermGrepTopK(input: {
  termCount: number;
  totalTopK: number;
}) {
  if (input.termCount <= 0) {
    return 0;
  }

  return Math.min(
    MAX_GREP_TERM_TOP_K,
    Math.max(MIN_GREP_TERM_TOP_K, Math.ceil(input.totalTopK / input.termCount)),
  );
}

export function mergeVirtualFsGrepCandidates(
  candidates: VirtualFsGrepCandidate[],
  limit: number,
) {
  const byChunkId = new Map<string, VirtualFsGrepCandidate>();

  for (const candidate of candidates) {
    const existing = byChunkId.get(candidate.chunkId);
    if (!existing || candidate.score > existing.score) {
      byChunkId.set(candidate.chunkId, candidate);
    }
  }

  return Array.from(byChunkId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

export async function grepVirtualFsChunksByRecallTerms(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
  terms: string[];
  totalTopK: number;
}): Promise<VirtualFsGrepCandidate[]> {
  const terms = Array.from(
    new Set(
      input.terms
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  );
  const perTermTopK = calculatePerTermGrepTopK({
    termCount: terms.length,
    totalTopK: input.totalTopK,
  });

  if (perTermTopK === 0) {
    return [];
  }

  const candidateLists = await Promise.all(
    terms.map((term) =>
      grepVirtualFsChunks({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        sourceIds: input.sourceIds,
        queryText: term,
        topK: perTermTopK,
      }),
    ),
  );

  return mergeVirtualFsGrepCandidates(candidateLists.flat(), input.totalTopK);
}

export async function grepVirtualFsChunksByRegex(input: {
  teamId: string;
  workspaceId: string;
  sourceIds: string[];
  pattern: string;
  limit: number;
}): Promise<VirtualFsGrepCandidate[]> {
  const rows = await db.execute<{
    source_id: string;
    source_title: string;
    source_file_name: string | null;
    document_id: string;
    chunk_id: string;
    chunk_no: number;
    content: string;
    start_offset: number | null;
    end_offset: number | null;
    heading_path: string | null;
    language: string | null;
  }>(sql`
    select
      c.source_id,
      s.title as source_title,
      nullif(s.metadata_json->>'fileName', '') as source_file_name,
      c.document_id,
      c.id as chunk_id,
      c.chunk_no,
      c.content,
      c.start_offset,
      c.end_offset,
      c.heading_path,
      c.language
    from chunks c
    inner join sources s on s.id = c.source_id
    inner join documents d on d.id = c.document_id
    where c.team_id = ${input.teamId}
      and c.workspace_id = ${input.workspaceId}
      and s.status = 'indexed'
      and c.content ~* ${input.pattern}
      ${sourceIdsClause(input.sourceIds)}
      and not exists (
        select 1
        from documents newer_documents
        where newer_documents.team_id = d.team_id
          and newer_documents.workspace_id = d.workspace_id
          and newer_documents.source_id = d.source_id
          and (
            newer_documents.created_at > d.created_at
            or (
              newer_documents.created_at = d.created_at
              and newer_documents.id > d.id
            )
          )
      )
    order by c.chunk_no asc
    limit ${input.limit}
  `);

  return rows.rows.map((row) => ({
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceFileName: row.source_file_name,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    chunkNo: Number(row.chunk_no),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    headingPath: row.heading_path,
    language: row.language,
    score: 0,
  }));
}
