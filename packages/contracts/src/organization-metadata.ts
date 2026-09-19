type SourceweftOrganizationMetadata = {
  sourceweft?: {
    kind?: "personal" | "team";
  };
};

function parseOrganizationMetadata(metadata: unknown) {
  if (!metadata) return {};
  if (typeof metadata === "object") {
    return metadata as SourceweftOrganizationMetadata;
  }
  if (typeof metadata !== "string") return {};

  try {
    let parsed: unknown = JSON.parse(metadata);
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }

    return parsed && typeof parsed === "object"
      ? (parsed as SourceweftOrganizationMetadata)
      : {};
  } catch {
    return {};
  }
}

export function isPersonalOrganization(org: { metadata?: unknown }) {
  return (
    parseOrganizationMetadata(org.metadata).sourceweft?.kind === "personal"
  );
}
