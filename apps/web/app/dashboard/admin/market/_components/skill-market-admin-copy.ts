import type {
  SkillMarketAdminStandingFilter,
  SkillMarketEvent,
  SkillMarketEventActorKind,
} from "@sourceweft/contracts";

/**
 * English strings for the market admin's all-skills list, the audit trail,
 * the admin nav entry, restoring a removed repository and the rate-limit
 * notice on an import. Kept in one module so it can be localized in one place.
 */
export const skillMarketAdminCopy = {
  all: {
    title: "All community skills",
    description:
      "Every community skill, whatever its standing. Newest change first.",
    searchLabel: "Search skills",
    searchPlaceholder: "Name, slug or owner/repo",
    search: "Search",
    standingLabel: "Standing",
    standing: {
      any: "Any standing",
      public: "Public",
      restricted: "Not listed",
      held: "Withdrawn by an admin",
      owner_held: "Kept private by its author",
    } satisfies Record<SkillMarketAdminStandingFilter | "any", string>,
    flags: {
      featured: "Featured",
      verified: "Verified",
      claimed: "Claimed",
      flagged: "Has scan flags",
      reported: "Has open reports",
    },
    tri: { any: "Any", yes: "Yes", no: "No" },
    columns: {
      skill: "Skill",
      standing: "Standing",
      marks: "Marks",
      installs: "Installs",
      rating: "Rating",
      updated: "Updated",
    },
    public: "Public",
    notListed: "Not listed",
    heldByAdmin: "Withdrawn",
    heldByOwner: "Author keeps private",
    flagCount: (count: number) => `${count} flag${count === 1 ? "" : "s"}`,
    reportCount: (count: number) =>
      `${count} open report${count === 1 ? "" : "s"}`,
    noRating: "—",
    rating: (avg: number, count: number) => `${avg.toFixed(1)} (${count})`,
    empty: "No skills match these filters.",
    loadMore: "Load more",
    loading: "Loading…",
    failed: "Could not load the skills.",
    reinfer: "Re-infer categories (auto only)",
    reinferConfirm:
      "Re-infer the categories of every skill whose categories were inferred? Categories an admin picked are left alone.",
    reinferDone: (considered: number, changed: number) =>
      `Re-inferred ${considered} skill${considered === 1 ? "" : "s"}; ${changed} changed.`,
    reinferFailed: "Could not re-infer categories.",
  },
  events: {
    feedTitle: "Recent market events",
    show: "Show",
    hide: "Hide",
    skillTitle: "Market history",
    empty: "Nothing recorded yet.",
    loadMore: "Load more",
    failed: "Could not load the market events.",
    reinfer: "Re-infer categories",
    reinferDone: (slugs: string[]) =>
      `Categories now: ${slugs.length ? slugs.join(", ") : "none"}.`,
    reinferFailed: "Could not re-infer categories.",
    platform: "SourceWeft",
    actorKind: {
      admin: "admin",
      owner: "author",
      user: "user",
      system: "platform",
    } satisfies Record<SkillMarketEventActorKind, string>,
    actions: {
      "listing.listed": "Listed publicly",
      "listing.withdrawn": "Withdrawn from the market",
      "listing.auto_listed": "Listed automatically",
      "listing.owner_allowed": "Author allowed listing",
      "listing.owner_private": "Author made it private",
      "listing.kept": "Kept public after a new version",
      "verified.set": "Verified badge changed",
      "verified.cleared": "Verified badge cleared by a new version",
      "featured.set": "Featured changed",
      "categories.set": "Categories set",
      "categories.reinferred": "Categories re-inferred",
      "provenance.withheld": "Withheld: commit not on the default branch",
      "claim.granted": "Repository claimed",
      "claim.revoked": "Claim revoked",
      "claim.removed": "Author removed the repository",
      "claim.restored": "Author restored the repository",
      "version.published": "Version published",
      "version.rejected": "Version rejected",
      "version.revoked": "Version revoked",
      "review.written": "Review written",
      "review.deleted": "Review deleted",
      "review.replied": "Author replied to a review",
      "review.reply_removed": "Author reply removed",
      "review.hidden": "Review hidden",
      "review.shown": "Review shown again",
      "report.actioned": "Report acted on",
      "report.dismissed": "Report dismissed",
      "overview.regenerated": "AI overview regenerated",
      "overview.hidden": "AI overview hidden",
      "overview.shown": "AI overview shown again",
      "settings.updated": "Market settings updated",
    } as Record<string, string>,
    verifiedCleared: (from: string | null, to: string | null) =>
      `Version ${shortId(from)} → ${shortId(to)}`,
    bulk: "all inferred skills",
  },
  nav: {
    marketAdmin: "Market admin",
  },
  restore: {
    button: "Restore to SourceWeft",
    restored: (count: number) =>
      `Restored. ${count} skill${count === 1 ? "" : "s"} will be listed again by the platform's rules shortly.`,
    nothing: "Nothing to restore.",
    failed: "Could not restore the repository.",
  },
  rateLimit: {
    notice: (time: string) =>
      `GitHub rate limit reached — resumes around ${time}`,
    noticeUnknown: "GitHub rate limit reached — the import resumes shortly",
  },
};

function shortId(id: string | null) {
  return id ? id.slice(0, 8) : "?";
}

const text = (value: unknown) =>
  typeof value === "string" ? value : value == null ? null : String(value);

/** A from/to pair recorded as `{ from, to }`, when it is one. */
function change(value: unknown): { from: unknown; to: unknown } | null {
  return value && typeof value === "object" && "to" in value
    ? (value as { from: unknown; to: unknown })
    : null;
}

function show(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value === null || value === undefined) return "none";
  return String(value);
}

/** The human label for an action; an unknown action shows as its name. */
export function skillMarketEventLabel(action: string): string {
  return skillMarketAdminCopy.events.actions[action] ?? action;
}

/**
 * One line of what an event changed, from its small structured detail: the
 * versions behind a cleared badge, from → to pairs, a reason.
 */
export function skillMarketEventSummary(event: SkillMarketEvent): string {
  const detail = event.detail;
  if (event.action === "verified.cleared") {
    return skillMarketAdminCopy.events.verifiedCleared(
      text(detail.fromVersionId),
      text(detail.toVersionId),
    );
  }
  const parts: string[] = [];
  for (const key of [
    "visibility",
    "listingHoldBy",
    "verified",
    "featured",
    "categorySlugs",
    "status",
  ]) {
    const pair = change(detail[key]);
    if (pair) parts.push(`${key}: ${show(pair.from)} → ${show(pair.to)}`);
  }
  if (typeof detail.reason === "string" && detail.reason) {
    parts.push(`“${detail.reason}”`);
  }
  if (typeof detail.skillCount === "number") {
    parts.push(
      `${detail.skillCount} skill${detail.skillCount === 1 ? "" : "s"}`,
    );
  }
  if (detail.bulk === true && typeof detail.changed === "number") {
    parts.push(
      `${skillMarketAdminCopy.events.bulk}: ${String(detail.considered)} considered, ${detail.changed} changed`,
    );
  }
  return parts.join(" · ");
}

/** Who did it: the actor's name (or id), with what kind of actor they were. */
export function skillMarketEventActor(event: SkillMarketEvent): string {
  const kind = skillMarketAdminCopy.events.actorKind[event.actorKind];
  if (event.actorKind === "system" || !event.actorUserId) {
    return skillMarketAdminCopy.events.platform;
  }
  return `${event.actorName ?? event.actorUserId} (${kind})`;
}

export function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
