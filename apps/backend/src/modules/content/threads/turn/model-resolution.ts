import { and, eq } from "drizzle-orm";
import { db } from "../../../../shared/database";
import {
  modelGatewayProfiles,
  modelGatewayProviderConfigs,
} from "../../../../shared/db/schema";
import { requireDefaultModelGatewayProfile } from "../../../../shared/model-gateway/index";
import { ContentError } from "../../errors";
import {
  type ThreadModelSettings,
} from "../model-settings";

const DEFAULT_MODEL_ALIAS = "chat-default";

export async function resolveThreadChatProfile(input: {
  threadModelSettings: ThreadModelSettings;
  requestedProfileAlias?: string | null;
  requestedModelAlias?: string | null;
}) {
  const requestedProfileAlias =
    typeof input.requestedProfileAlias === "string"
      ? input.requestedProfileAlias.trim()
      : "";
  if (requestedProfileAlias.length > 0) {
    const profile = await resolveActiveChatProfileByAlias(requestedProfileAlias);
    return {
      profileAlias: profile.profileAlias,
      modelAlias: profile.modelAlias,
      persistedProfileAlias: profile.profileAlias,
      persistedModelAlias: profile.modelAlias,
    };
  }
  const requestedModelAlias =
    typeof input.requestedModelAlias === "string"
      ? input.requestedModelAlias.trim()
      : "";
  if (requestedModelAlias.length > 0) {
    const profile = await resolveActiveChatProfileByModelAlias(requestedModelAlias);
    return {
      profileAlias: profile.profileAlias,
      modelAlias: profile.modelAlias,
      persistedProfileAlias: profile.profileAlias,
      persistedModelAlias: profile.modelAlias,
    };
  }

  const threadProfileAlias = input.threadModelSettings.llmProfileAlias;
  if (threadProfileAlias) {
    const [row] = await db
      .select({
        profileAlias: modelGatewayProfiles.profileAlias,
        modelAlias: modelGatewayProfiles.modelAlias,
      })
      .from(modelGatewayProfiles)
      .where(
        and(
          eq(modelGatewayProfiles.kind, "chat"),
          eq(modelGatewayProfiles.profileAlias, threadProfileAlias),
          eq(modelGatewayProfiles.isActive, true),
        ),
      )
      .limit(1);

    if (row) {
      return {
        profileAlias: row.profileAlias,
        modelAlias: row.modelAlias,
        persistedProfileAlias: row.profileAlias,
        persistedModelAlias: row.modelAlias,
      };
    }
  }

  const defaultChatProfile = await requireDefaultModelGatewayProfile("chat");
  const fallbackProfileAlias = defaultChatProfile.profileAlias || DEFAULT_MODEL_ALIAS;
  const fallbackModelAlias = defaultChatProfile.modelAlias || DEFAULT_MODEL_ALIAS;

  return {
    profileAlias: fallbackProfileAlias,
    modelAlias: fallbackModelAlias,
    persistedProfileAlias: fallbackProfileAlias,
    persistedModelAlias: fallbackModelAlias,
  };
}

export async function resolveActiveChatProfileByModelAlias(modelAlias: string) {
  const [row] = await db
    .select({
      configJson: modelGatewayProfiles.configJson,
      gatewayConfigId: modelGatewayProfiles.gatewayConfigId,
      modelAlias: modelGatewayProfiles.modelAlias,
      profileAlias: modelGatewayProfiles.profileAlias,
      kind: modelGatewayProfiles.kind,
      providerKind: modelGatewayProviderConfigs.providerKind,
    })
    .from(modelGatewayProfiles)
    .leftJoin(
      modelGatewayProviderConfigs,
      eq(modelGatewayProviderConfigs.gatewayConfigId, modelGatewayProfiles.gatewayConfigId),
    )
    .where(
      and(
        eq(modelGatewayProfiles.kind, "chat"),
        eq(modelGatewayProfiles.modelAlias, modelAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ContentError(
      400,
      "MODEL_ALIAS_INVALID",
      `Model alias '${modelAlias}' is not available for chat`,
    );
  }

  return row;
}

export async function resolveActiveChatProfileByAlias(profileAlias: string) {
  const [row] = await db
    .select({
      configJson: modelGatewayProfiles.configJson,
      gatewayConfigId: modelGatewayProfiles.gatewayConfigId,
      modelAlias: modelGatewayProfiles.modelAlias,
      profileAlias: modelGatewayProfiles.profileAlias,
      kind: modelGatewayProfiles.kind,
      providerKind: modelGatewayProviderConfigs.providerKind,
    })
    .from(modelGatewayProfiles)
    .leftJoin(
      modelGatewayProviderConfigs,
      eq(modelGatewayProviderConfigs.gatewayConfigId, modelGatewayProfiles.gatewayConfigId),
    )
    .where(
      and(
        eq(modelGatewayProfiles.kind, "chat"),
        eq(modelGatewayProfiles.profileAlias, profileAlias),
        eq(modelGatewayProfiles.isActive, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ContentError(
      400,
      "MODEL_PROFILE_ALIAS_INVALID",
      `Model profile alias '${profileAlias}' is not available for chat`,
    );
  }

  return row;
}
