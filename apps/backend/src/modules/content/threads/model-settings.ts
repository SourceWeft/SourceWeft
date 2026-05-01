import { and, eq } from "drizzle-orm";
import { db } from "../../../shared/database";
import { modelGatewayProfiles } from "../../../shared/db/schema";
import { ContentError } from "../errors";

export type ThreadModelKind = "llm" | "image" | "vision";
export type ModelProfileKind = "chat" | "image" | "vision";

export type ThreadModelSettings = {
  llmProfileAlias: string | null;
  imageProfileAlias: string | null;
  visionProfileAlias: string | null;
  llmModelAlias: string | null;
  imageModelAlias: string | null;
  visionModelAlias: string | null;
};

type ThreadModelSettingsInput = Partial<ThreadModelSettings> & {
  llmProfileAlias?: string | null;
  imageProfileAlias?: string | null;
  visionProfileAlias?: string | null;
};

export const MODEL_KIND_BY_THREAD_KIND: Record<
  ThreadModelKind,
  ModelProfileKind
> = {
  llm: "chat",
  image: "image",
  vision: "vision",
};

export const THREAD_KIND_BY_MODEL_KIND: Record<
  ModelProfileKind,
  ThreadModelKind
> = {
  chat: "llm",
  image: "image",
  vision: "vision",
};

export function normalizeThreadModelSettings(
  input:
    | Partial<ThreadModelSettings>
    | {
        llmProfileAlias?: string | null;
        imageProfileAlias?: string | null;
        visionProfileAlias?: string | null;
        llmModelAlias?: string | null;
        imageModelAlias?: string | null;
        visionModelAlias?: string | null;
      }
    | undefined,
): ThreadModelSettings {
  const normalizeAlias = (value: string | null | undefined) => {
    const MAX_ALIAS_LENGTH = 512;
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > MAX_ALIAS_LENGTH) {
      throw new ContentError(
        400,
        "MODEL_ALIAS_INVALID",
        `Model alias must be at most ${MAX_ALIAS_LENGTH} characters`,
      );
    }
    return trimmed;
  };

  return {
    llmProfileAlias: normalizeAlias(input?.llmProfileAlias),
    imageProfileAlias: normalizeAlias(input?.imageProfileAlias),
    visionProfileAlias: normalizeAlias(input?.visionProfileAlias),
    llmModelAlias: normalizeAlias(input?.llmModelAlias),
    imageModelAlias: normalizeAlias(input?.imageModelAlias),
    visionModelAlias: normalizeAlias(input?.visionModelAlias),
  };
}

export function normalizePersistedThreadModelSettings(
  input: ThreadModelSettingsInput | undefined,
): ThreadModelSettings {
  try {
    return normalizeThreadModelSettings({
      llmProfileAlias: input?.llmProfileAlias,
      imageProfileAlias: input?.imageProfileAlias,
      visionProfileAlias: input?.visionProfileAlias,
      llmModelAlias: input?.llmModelAlias,
      imageModelAlias: input?.imageModelAlias,
      visionModelAlias: input?.visionModelAlias,
    });
  } catch (error) {
    if (
      error instanceof ContentError &&
      error.code === "MODEL_ALIAS_INVALID"
    ) {
      return {
        llmProfileAlias: null,
        imageProfileAlias: null,
        visionProfileAlias: null,
        llmModelAlias: null,
        imageModelAlias: null,
        visionModelAlias: null,
      };
    }
    throw error;
  }
}

export function mergeThreadModelSettings(
  current: ThreadModelSettings,
  patch: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
    llmModelAlias?: string | null;
    imageModelAlias?: string | null;
    visionModelAlias?: string | null;
  },
): ThreadModelSettings {
  const next = { ...current };
  if (patch.llmProfileAlias !== undefined) {
    next.llmProfileAlias = normalizeThreadModelSettings({
      llmProfileAlias: patch.llmProfileAlias,
    }).llmProfileAlias;
  }
  if (patch.imageProfileAlias !== undefined) {
    next.imageProfileAlias = normalizeThreadModelSettings({
      imageProfileAlias: patch.imageProfileAlias,
    }).imageProfileAlias;
  }
  if (patch.visionProfileAlias !== undefined) {
    next.visionProfileAlias = normalizeThreadModelSettings({
      visionProfileAlias: patch.visionProfileAlias,
    }).visionProfileAlias;
  }
  if (patch.llmModelAlias !== undefined) {
    next.llmModelAlias = normalizeThreadModelSettings({
      llmModelAlias: patch.llmModelAlias,
    }).llmModelAlias;
  }
  if (patch.imageModelAlias !== undefined) {
    next.imageModelAlias = normalizeThreadModelSettings({
      imageModelAlias: patch.imageModelAlias,
    }).imageModelAlias;
  }
  if (patch.visionModelAlias !== undefined) {
    next.visionModelAlias = normalizeThreadModelSettings({
      visionModelAlias: patch.visionModelAlias,
    }).visionModelAlias;
  }

  if (patch.llmProfileAlias !== undefined && patch.llmModelAlias === undefined) {
    next.llmModelAlias = null;
  } else if (patch.llmModelAlias !== undefined && patch.llmProfileAlias === undefined) {
    next.llmProfileAlias = null;
  }
  if (patch.imageProfileAlias !== undefined && patch.imageModelAlias === undefined) {
    next.imageModelAlias = null;
  } else if (patch.imageModelAlias !== undefined && patch.imageProfileAlias === undefined) {
    next.imageProfileAlias = null;
  }
  if (patch.visionProfileAlias !== undefined && patch.visionModelAlias === undefined) {
    next.visionModelAlias = null;
  } else if (patch.visionModelAlias !== undefined && patch.visionProfileAlias === undefined) {
    next.visionProfileAlias = null;
  }

  return next;
}

export function applyResolvedThreadModelSettings(
  current: ThreadModelSettings,
  patch: {
    llm?: { profileAlias: string | null; modelAlias: string | null };
    image?: { profileAlias: string | null; modelAlias: string | null };
    vision?: { profileAlias: string | null; modelAlias: string | null };
  },
): ThreadModelSettings {
  return {
    ...current,
    ...(patch.llm
      ? {
          llmProfileAlias: normalizeThreadModelSettings({
            llmProfileAlias: patch.llm.profileAlias,
          }).llmProfileAlias,
          llmModelAlias: normalizeThreadModelSettings({
            llmModelAlias: patch.llm.modelAlias,
          }).llmModelAlias,
        }
      : {}),
    ...(patch.image
      ? {
          imageProfileAlias: normalizeThreadModelSettings({
            imageProfileAlias: patch.image.profileAlias,
          }).imageProfileAlias,
          imageModelAlias: normalizeThreadModelSettings({
            imageModelAlias: patch.image.modelAlias,
          }).imageModelAlias,
        }
      : {}),
    ...(patch.vision
      ? {
          visionProfileAlias: normalizeThreadModelSettings({
            visionProfileAlias: patch.vision.profileAlias,
          }).visionProfileAlias,
          visionModelAlias: normalizeThreadModelSettings({
            visionModelAlias: patch.vision.modelAlias,
          }).visionModelAlias,
        }
      : {}),
  };
}

export async function ensureProfileAliasExists(input: {
  profileKind: ModelProfileKind;
  profileAlias: string;
}) {
  const [row] = await db
    .select({ id: modelGatewayProfiles.id })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.profileKind),
        eq(modelGatewayProfiles.profileAlias, input.profileAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ContentError(
      400,
      "MODEL_PROFILE_ALIAS_INVALID",
      `Model profile alias '${input.profileAlias}' is not available for ${input.profileKind}`,
    );
  }
}

async function resolveActiveProfileModelAlias(input: {
  profileKind: ModelProfileKind;
  profileAlias: string;
}) {
  const [row] = await db
    .select({ modelAlias: modelGatewayProfiles.modelAlias })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.profileKind),
        eq(modelGatewayProfiles.profileAlias, input.profileAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ContentError(
      400,
      "MODEL_PROFILE_ALIAS_INVALID",
      `Model profile alias '${input.profileAlias}' is not available for ${input.profileKind}`,
    );
  }

  return row.modelAlias;
}

export async function resolveThreadModelSettingsSnapshots(
  settings: ThreadModelSettings,
): Promise<ThreadModelSettings> {
  const next = { ...settings };

  if (next.llmProfileAlias) {
    next.llmModelAlias = await resolveActiveProfileModelAlias({
      profileKind: "chat",
      profileAlias: next.llmProfileAlias,
    });
  } else {
    next.llmModelAlias = null;
  }

  if (next.imageProfileAlias) {
    next.imageModelAlias = await resolveActiveProfileModelAlias({
      profileKind: "image",
      profileAlias: next.imageProfileAlias,
    });
  } else {
    next.imageModelAlias = null;
  }

  if (next.visionProfileAlias) {
    next.visionModelAlias = await resolveActiveProfileModelAlias({
      profileKind: "vision",
      profileAlias: next.visionProfileAlias,
    });
  } else {
    next.visionModelAlias = null;
  }

  return next;
}

export async function ensureModelAliasExists(input: {
  profileKind: ModelProfileKind;
  modelAlias: string;
}) {
  const [row] = await db
    .select({ id: modelGatewayProfiles.id })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.profileKind),
        eq(modelGatewayProfiles.modelAlias, input.modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ContentError(
      400,
      "MODEL_ALIAS_INVALID",
      `Model alias '${input.modelAlias}' is not available for ${input.profileKind}`,
    );
  }
}

export async function hasActiveProfileAlias(input: {
  profileKind: ModelProfileKind;
  profileAlias: string;
}) {
  const [row] = await db
    .select({ id: modelGatewayProfiles.id })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.profileKind),
        eq(modelGatewayProfiles.profileAlias, input.profileAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function hasActiveModelAlias(input: {
  profileKind: ModelProfileKind;
  modelAlias: string;
}) {
  const [row] = await db
    .select({ id: modelGatewayProfiles.id })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.kind, input.profileKind),
        eq(modelGatewayProfiles.modelAlias, input.modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function pruneUnavailableThreadModelAliases(
  settings: ThreadModelSettings,
  patch: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  },
): Promise<ThreadModelSettings> {
  const next = { ...settings };

  if (patch.llmProfileAlias === undefined && next.llmProfileAlias) {
    const valid = await hasActiveProfileAlias({
      profileKind: "chat",
      profileAlias: next.llmProfileAlias,
    });
    if (!valid) {
      next.llmProfileAlias = null;
      next.llmModelAlias = null;
    }
  }

  if (patch.imageProfileAlias === undefined && next.imageProfileAlias) {
    const valid = await hasActiveProfileAlias({
      profileKind: "image",
      profileAlias: next.imageProfileAlias,
    });
    if (!valid) {
      next.imageProfileAlias = null;
      next.imageModelAlias = null;
    }
  }

  if (patch.visionProfileAlias === undefined && next.visionProfileAlias) {
    const valid = await hasActiveProfileAlias({
      profileKind: "vision",
      profileAlias: next.visionProfileAlias,
    });
    if (!valid) {
      next.visionProfileAlias = null;
      next.visionModelAlias = null;
    }
  }

  return next;
}

export async function validateThreadModelSettings(
  settings: ThreadModelSettings,
) {
  for (const [threadKind, profileKind] of Object.entries(
    MODEL_KIND_BY_THREAD_KIND,
  ) as Array<[ThreadModelKind, ModelProfileKind]>) {
    const alias =
      threadKind === "llm"
        ? settings.llmProfileAlias
        : threadKind === "image"
          ? settings.imageProfileAlias
          : settings.visionProfileAlias;

    if (!alias) {
      continue;
    }

    await ensureProfileAliasExists({ profileKind, profileAlias: alias });
  }
}
