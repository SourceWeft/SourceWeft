export type SourceweftOrganizationKind = "personal" | "team";

type SourceweftOrganizationMetadata = {
  sourceweft?: {
    kind?: SourceweftOrganizationKind;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOrganizationMetadataObject(metadata: unknown) {
  let parsed: unknown = metadata;

  if (typeof metadata === "string") {
    if (!metadata.trim()) {
      return null;
    }

    try {
      parsed = JSON.parse(metadata);
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
    } catch {
      return null;
    }
  }

  return isRecord(parsed) ? parsed : null;
}

export function createSourceweftOrganizationMetadata(
  kind: SourceweftOrganizationKind,
) {
  return { sourceweft: { kind } };
}

/**
 * Returns the metadata unchanged except for `sourceweft.kind`. The explicit
 * return type is needed because the `?? {}` fallback would otherwise narrow the
 * inferred type and hide the caller's own top-level keys.
 */
export function withSourceweftOrganizationKind(
  metadata: unknown,
  kind: SourceweftOrganizationKind,
): Record<string, unknown> & {
  sourceweft: Record<string, unknown> & {
    kind: SourceweftOrganizationKind;
  };
} {
  const parsed = parseOrganizationMetadataObject(metadata) ?? {};
  const sourceweft = isRecord(parsed.sourceweft) ? parsed.sourceweft : {};

  return {
    ...parsed,
    sourceweft: {
      ...sourceweft,
      kind,
    },
  };
}

export function parseSourceweftOrganizationKind(
  metadata: unknown,
): SourceweftOrganizationKind | null {
  const parsed = parseOrganizationMetadataObject(metadata);
  if (!parsed) {
    return null;
  }

  const sourceweft = (parsed as SourceweftOrganizationMetadata).sourceweft;
  const kind = sourceweft?.kind;

  return kind === "personal" || kind === "team" ? kind : null;
}

export function isPersonalOrganizationMetadata(metadata: unknown) {
  return parseSourceweftOrganizationKind(metadata) === "personal";
}
