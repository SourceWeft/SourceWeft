import { and, eq } from "drizzle-orm";
import { db } from "../../../shared/database";
import { modelGatewayProfiles } from "../../../shared/db/schema";
import { ContentError } from "../errors";

export type ThreadModelKind = "llm" | "image" | "vision";
export type ModelProfileKind = "chat" | "image" | "vision";

export type ThreadModelSettings = {
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
      llmModelAlias: input?.llmModelAlias ?? input?.llmProfileAlias,
      imageModelAlias: input?.imageModelAlias ?? input?.imageProfileAlias,
      visionModelAlias: input?.visionModelAlias ?? input?.visionProfileAlias,
    });
  } catch (error) {
    if (
      error instanceof ContentError &&
      error.code === "MODEL_ALIAS_INVALID"
    ) {
      return {
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
    llmModelAlias?: string | null;
    imageModelAlias?: string | null;
    visionModelAlias?: string | null;
  },
): ThreadModelSettings {
  const next = { ...current };
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
    llmModelAlias?: string | null;
    imageModelAlias?: string | null;
    visionModelAlias?: string | null;
  },
): Promise<ThreadModelSettings> {
  const next = { ...settings };

  if (patch.llmModelAlias === undefined && next.llmModelAlias) {
    const valid = await hasActiveModelAlias({
      profileKind: "chat",
      modelAlias: next.llmModelAlias,
    });
    if (!valid) {
      next.llmModelAlias = null;
    }
  }

  if (patch.imageModelAlias === undefined && next.imageModelAlias) {
    const valid = await hasActiveModelAlias({
      profileKind: "image",
      modelAlias: next.imageModelAlias,
    });
    if (!valid) {
      next.imageModelAlias = null;
    }
  }

  if (patch.visionModelAlias === undefined && next.visionModelAlias) {
    const valid = await hasActiveModelAlias({
      profileKind: "vision",
      modelAlias: next.visionModelAlias,
    });
    if (!valid) {
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
        ? settings.llmModelAlias
        : threadKind === "image"
          ? settings.imageModelAlias
          : settings.visionModelAlias;

    if (!alias) {
      continue;
    }

    await ensureModelAliasExists({
      profileKind,
      modelAlias: alias,
    });
  }
}
