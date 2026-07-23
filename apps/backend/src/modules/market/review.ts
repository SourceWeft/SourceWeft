import { and, desc, eq, inArray } from "drizzle-orm";
import { db, marketItems, marketItemVersions } from "@sourceweft/db";

export type ReviewQueueEntry = {
  identifier: string;
  name: string;
  summary: string;
  repoUrl: string | null;
  transport: unknown;
  authType: unknown;
  submittedBy: string | null;
  flags: string[];
  createdAt: string;
};

function readScan(provenance: Record<string, unknown> | null | undefined) {
  const scan = provenance?.scan as { flags?: unknown } | undefined;
  const flags = Array.isArray(scan?.flags)
    ? scan.flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  const submittedBy =
    typeof provenance?.submittedBy === "string" ? provenance.submittedBy : null;
  return { flags, submittedBy };
}

/**
 * Submissions awaiting human review (auto-triaged as flagged). Small by design:
 * clean submissions publish without ever entering this queue.
 */
export async function listReviewQueue(): Promise<ReviewQueueEntry[]> {
  const items = await db
    .select()
    .from(marketItems)
    .where(eq(marketItems.status, "reviewing"))
    .orderBy(desc(marketItems.createdAt));
  if (items.length === 0) {
    return [];
  }

  const versions = await db
    .select()
    .from(marketItemVersions)
    .where(
      inArray(
        marketItemVersions.itemId,
        items.map((item) => item.id),
      ),
    );
  const provenanceByItem = new Map<string, Record<string, unknown>>();
  for (const version of versions) {
    if (!provenanceByItem.has(version.itemId)) {
      provenanceByItem.set(version.itemId, version.provenanceJson ?? {});
    }
  }

  const meta = (value: Record<string, unknown> | null) => value ?? {};
  return items.map((item) => {
    const metadata = meta(item.metadataJson);
    const { flags, submittedBy } = readScan(provenanceByItem.get(item.id));
    return {
      identifier: item.identifier,
      name: item.name,
      summary: item.summary,
      repoUrl: item.repoUrl,
      transport: metadata.transport ?? null,
      authType: metadata.requiresAuth ?? null,
      submittedBy,
      flags,
      createdAt: item.createdAt.toISOString(),
    };
  });
}

/**
 * Approve (publish) or reject (archive) a submission. Only acts on items that
 * are actually in review, so publish/reject can't clobber a federated entry.
 */
export async function setSubmissionStatus(
  identifier: string,
  status: "published" | "archived",
): Promise<{ identifier: string; status: string } | null> {
  const [item] = await db
    .select()
    .from(marketItems)
    .where(
      and(
        eq(marketItems.identifier, identifier),
        eq(marketItems.status, "reviewing"),
      ),
    )
    .limit(1);
  if (!item) {
    return null;
  }

  const now = new Date();
  const publishedAt = status === "published" ? now : null;
  await db
    .update(marketItems)
    .set({ status, publishedAt, updatedAt: now })
    .where(eq(marketItems.id, item.id));
  await db
    .update(marketItemVersions)
    .set({ status, publishedAt })
    .where(eq(marketItemVersions.itemId, item.id));

  return { identifier, status };
}
