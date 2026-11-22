import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, notes } from "@sourceweft/db";
import type { SavedAnswerNote } from "@sourceweft/contracts/sources";
import type { ResearchRun } from "@sourceweft/contracts/source-research";
import { ContentError } from "../content/errors";
import { normalizeContentTitle } from "../../shared/strings";
import { logger } from "../../shared/logger";
import {
  contentSourceService,
  createSourceRecord,
  sourceIndexingService,
} from "../sources";
import { computeContentHash } from "../sources/content-hash";
import { findRun } from "../sources/research/repository";
import { toResearchRun } from "../sources/research/mapper";
import { requireContentWorkspace } from "../workspace/guards";

type NoteRow = typeof notes.$inferSelect;

const TITLE_MAX_CHARS = 80;

/** A short note title from the run's topic. */
function researchNoteTitle(topic: string): string {
  const clean = topic.replace(/\s+/g, " ").trim();
  if (clean.length <= TITLE_MAX_CHARS) {
    return normalizeContentTitle(clean, "Research report");
  }
  const cut = clean.slice(0, TITLE_MAX_CHARS);
  const atWord = cut.lastIndexOf(" ");
  const trimmed = (
    atWord > TITLE_MAX_CHARS / 2 ? cut.slice(0, atWord) : cut
  ).trimEnd();
  return `${trimmed}…`;
}

/**
 * The report kept verbatim — its `[n]` markers stay as plain text — with a
 * numbered Sources list appended so each marker resolves to a page url without
 * the run: `[n]` lines up with Sources entry n (the nth verified citation).
 * Two citations of the same page are two Sources entries with the same url by
 * design, so every marker keeps its own numbered line. A report that cites
 * nothing instead lists every page that was read, so the note is self-contained
 * either way.
 */
function buildResearchNoteMarkdown(run: ResearchRun): string {
  const body = (run.report ?? "").trimEnd();
  const sourceByEntry = new Map(run.sources.map((s) => [s.entryId, s]));

  const items: string[] = [];
  for (const citation of run.citations) {
    const source = sourceByEntry.get(citation.entryId);
    const label = source?.title.trim() || source?.url || citation.entryId;
    items.push(
      source
        ? `${items.length + 1}. [${label}](${source.url})`
        : `${items.length + 1}. ${label}`,
    );
  }
  if (items.length === 0) {
    run.sources.forEach((source, index) => {
      const label = source.title.trim() || source.url;
      items.push(`${index + 1}. [${label}](${source.url})`);
    });
  }
  if (items.length === 0) return body;
  return `${body}\n\n## Sources\n\n${items.join("\n")}`;
}

/** Finds the first note saved from this run, by the run id stamped in its JSON. */
async function findSavedResearchNote(
  input: { teamId: string; workspaceId: string; runId: string },
  executor: Pick<typeof db, "select"> = db,
): Promise<NoteRow | null> {
  const [row] = await executor
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.teamId, input.teamId),
        eq(notes.workspaceId, input.workspaceId),
        eq(notes.noteType, "generated"),
        sql`${notes.contentJson}->>'researchRunId' = ${input.runId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

function toResult(
  row: Pick<NoteRow, "id" | "sourceId" | "title">,
  alreadySaved: boolean,
): SavedAnswerNote {
  return {
    noteId: row.id,
    sourceId: row.sourceId ?? "",
    title: row.title ?? "",
    alreadySaved,
  };
}

/**
 * Saves a finished research report as a note: a `note` source indexed like any
 * other (so the report can be searched and cited later), plus the `notes` row
 * that remembers the run it came from. Only a `ready` run can be saved. Saving
 * the same run again returns the first note and creates nothing new, keyed on
 * the run id stamped into `contentJson`; a double-click is serialised on that
 * id so it cannot leave two notes. Indexing is charged to the person saving,
 * like any ingestion; if it fails nothing is left behind.
 */
export async function saveResearchReportAsNote(input: {
  workspaceId: string;
  userId: string;
  runId: string;
}): Promise<SavedAnswerNote> {
  const workspace = await requireContentWorkspace(input);

  const row = await findRun({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    id: input.runId,
  });
  if (!row) {
    throw new ContentError(404, "RESEARCH_NOT_FOUND", "Research run not found");
  }
  if (row.status !== "ready") {
    throw new ContentError(
      409,
      "RESEARCH_NOT_READY",
      "The research report is not ready to save.",
    );
  }
  const run = toResearchRun(row);

  // Fast path: a repeat save of the same run returns the first note.
  const existing = await findSavedResearchNote({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    runId: run.id,
  });
  if (existing?.sourceId) return toResult(existing, true);
  // A note whose source is gone cannot be opened; start over instead of handing
  // back a note that points at nothing.
  if (existing) await db.delete(notes).where(eq(notes.id, existing.id));

  const title = researchNoteTitle(run.topic);
  const markdown = buildResearchNoteMarkdown(run);

  const source = await createSourceRecord({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    title,
    contentText: markdown,
    createdBy: input.userId,
    ingestKind: "note",
    sourceType: "note",
    mimeType: "text/markdown",
    contentHash: computeContentHash(markdown),
  });

  try {
    await sourceIndexingService.indexSource({
      workspaceId: workspace.id,
      sourceId: source.id,
      userId: input.userId,
    });
  } catch (error) {
    await contentSourceService
      .deleteSource({
        workspaceId: workspace.id,
        sourceId: source.id,
        userId: input.userId,
      })
      .catch((cleanupError: unknown) =>
        logger.warn("Could not remove the source of a failed research note save", {
          err: cleanupError,
          sourceId: source.id,
        }),
      );
    throw error;
  }

  const noteId = randomUUID();
  let winner: NoteRow | null = null;
  try {
    await db.transaction(async (tx) => {
      // There is no unique column to lean on the way a saved chat answer leans
      // on its message id, so concurrent saves of the same run are serialised
      // on the run id: the first inserts, a racing second finds it here and
      // inserts nothing.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`research-note:${run.id}`}, 0))`,
      );
      const raced = await findSavedResearchNote(
        {
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          runId: run.id,
        },
        tx,
      );
      if (raced?.sourceId) {
        winner = raced;
        return;
      }
      await tx.insert(notes).values({
        id: noteId,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: null,
        sourceMessageId: null,
        sourceId: source.id,
        noteType: "generated",
        title,
        contentText: markdown,
        contentJson: { researchRunId: run.id, sources: run.sources },
        isEditable: true,
        createdBy: input.userId,
      });
    });
  } catch (error) {
    // The note row did not land, so nothing points at the source we indexed:
    // remove it before surfacing the failure, exactly as the index-failure path
    // above does. Only this call's own source is dropped — the race winner
    // returns from the callback and never throws, so it cannot reach here. A
    // cleanup failure is logged, not thrown, so it never masks the original.
    await contentSourceService
      .deleteSource({
        workspaceId: workspace.id,
        sourceId: source.id,
        userId: input.userId,
      })
      .catch((cleanupError: unknown) =>
        logger.warn(
          "Could not remove the source of a failed research note save",
          { err: cleanupError, sourceId: source.id },
        ),
      );
    throw error;
  }

  if (winner) {
    // A concurrent save won; keep its note and drop the duplicate source.
    await contentSourceService
      .deleteSource({
        workspaceId: workspace.id,
        sourceId: source.id,
        userId: input.userId,
      })
      .catch(() => undefined);
    return toResult(winner, true);
  }

  return { noteId, sourceId: source.id, title, alreadySaved: false };
}
