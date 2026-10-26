import { formatDisplayDate } from "@/lib/i18n/format";
import type {
  McpClaim,
  McpClaimOverview,
  McpOwnerOverridesInput,
} from "@sourceweft/contracts";

/** `?identifier=` as the claim page reads it: trimmed, or null when empty. */
export function normalizeClaimIdentifier(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export type McpClaimPageView =
  | { kind: "blocked" }
  | { kind: "owner" }
  | { kind: "claimedBySomeone" }
  | { kind: "open" };

/** Which of the page's bodies an overview gets. */
export function claimPageView(overview: McpClaimOverview): McpClaimPageView {
  // A block outranks everything: the viewer gets no method and no list.
  if (overview.blocked) return { kind: "blocked" };
  if (overview.claimedByYou) return { kind: "owner" };
  if (overview.claimed) return { kind: "claimedBySomeone" };
  return { kind: "open" };
}

/** The viewer's verified claim, whose id the revoke route takes. */
export function verifiedClaimOf(overview: McpClaimOverview): McpClaim | null {
  return (
    overview.viewerClaims.find((claim) => claim.status === "verified") ?? null
  );
}

/** Newest first; a revoked claim sinks below the ones that stand. */
export function sortMcpClaims(claims: readonly McpClaim[]) {
  const rank = (claim: McpClaim) =>
    claim.status === "verified" ? 0 : claim.status === "pending" ? 1 : 2;
  return [...claims].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt),
  );
}

export function formatMcpClaimDate(
  iso: string | null | undefined,
  displayLocale: string,
) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : formatDisplayDate(date, displayLocale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
}

// ---------------------------------------------------------------------------
// The owner's form.
// ---------------------------------------------------------------------------

export const OWNER_URL_FIELDS = [
  "iconUrl",
  "documentationUrl",
  "homepageUrl",
  "repoUrl",
] as const;
export const OWNER_TEXT_FIELDS = [
  "summary",
  "description",
  "license",
  "language",
] as const;
export type OwnerTextField =
  | (typeof OWNER_URL_FIELDS)[number]
  | (typeof OWNER_TEXT_FIELDS)[number];

export const OWNER_TEXT_LIMITS: Record<
  (typeof OWNER_TEXT_FIELDS)[number],
  number
> = {
  summary: 300,
  description: 5_000,
  license: 120,
  language: 64,
};

export type OwnerOverridesForm = Record<OwnerTextField, string> & {
  deprecated: boolean;
};

/** The form's starting state from what is stored (null and absent = empty). */
export function ownerOverridesForm(
  values: McpOwnerOverridesInput | null | undefined,
): OwnerOverridesForm {
  return {
    iconUrl: values?.iconUrl ?? "",
    summary: values?.summary ?? "",
    description: values?.description ?? "",
    license: values?.license ?? "",
    language: values?.language ?? "",
    documentationUrl: values?.documentationUrl ?? "",
    homepageUrl: values?.homepageUrl ?? "",
    repoUrl: values?.repoUrl ?? "",
    deprecated: values?.deprecated ?? false,
  };
}

/**
 * What the PUT sends: every field the form shows, an emptied one as null so
 * the stored value is cleared (the route replaces the whole set).
 */
export function ownerOverridesPayload(
  form: OwnerOverridesForm,
): McpOwnerOverridesInput {
  const text = (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };
  return {
    iconUrl: text(form.iconUrl),
    summary: text(form.summary),
    description: text(form.description),
    license: text(form.license),
    language: text(form.language),
    documentationUrl: text(form.documentationUrl),
    homepageUrl: text(form.homepageUrl),
    repoUrl: text(form.repoUrl),
    deprecated: form.deprecated,
  };
}

export type OwnerFormProblem =
  | { field: OwnerTextField; kind: "url" }
  | { field: OwnerTextField; kind: "tooLong"; max: number };

/** Client-side checks matching the contract: https URLs, length limits. */
export function ownerOverridesProblems(
  form: OwnerOverridesForm,
): OwnerFormProblem[] {
  const problems: OwnerFormProblem[] = [];
  for (const field of OWNER_URL_FIELDS) {
    const value = form[field].trim();
    if (!value) continue;
    if (!isHttpUrl(value) || value.length > 2_048) {
      problems.push({ field, kind: "url" });
    }
  }
  for (const field of OWNER_TEXT_FIELDS) {
    const max = OWNER_TEXT_LIMITS[field];
    if (form[field].trim().length > max) {
      problems.push({ field, kind: "tooLong", max });
    }
  }
  return problems;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * The CLI commands an owner runs on their own machine to list their server's
 * tools and upload the list. Placeholders where the page cannot know the
 * value; the credentials in them never reach SourceWeft.
 */
export function ownerToolsCliSnippet(identifier: string) {
  return [
    'sourceweft mcp inspect --url <endpoint> --header "Authorization: Bearer …"',
    `sourceweft mcp submit-tools ${identifier} mcp-tools.json --api-key <key>`,
  ].join("\n");
}
