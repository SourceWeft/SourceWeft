import { and, eq } from "drizzle-orm";
import { db } from "../../../../shared/database";
import { modelGatewayProfiles } from "../../../../shared/db/schema";
import { requireDefaultModelGatewayProfile } from "../../../../shared/model-gateway/index";
import { ContentError } from "../../errors";
import {
  ensureModelAliasExists,
  type ThreadModelSettings,
} from "../model-settings";

const DEFAULT_MODEL_ALIAS = "chat-default";

export async function resolveThreadChatModelAlias(input: {
  threadModelSettings: ThreadModelSettings;
  requestedModelAlias?: string | null;
}) {
  const requestedAlias =
    typeof input.requestedModelAlias === "string"
      ? input.requestedModelAlias.trim()
      : "";

  if (requestedAlias.length > 0) {
    await ensureModelAliasExists({
      profileKind: "chat",
      modelAlias: requestedAlias,
    });

    return {
      modelAlias: requestedAlias,
      persistedAlias: requestedAlias,
    };
  }

  const threadModelAlias = input.threadModelSettings.llmModelAlias;
  if (threadModelAlias) {
    const [row] = await db
      .select({ id: modelGatewayProfiles.id })
      .from(modelGatewayProfiles)
      .where(
        and(
          eq(modelGatewayProfiles.kind, "chat"),
          eq(modelGatewayProfiles.modelAlias, threadModelAlias),
          eq(modelGatewayProfiles.isActive, true),
        ),
      )
      .limit(1);

    if (row) {
      return {
        modelAlias: threadModelAlias,
        persistedAlias: threadModelAlias,
      };
    }
  }

  const defaultChatProfile = await requireDefaultModelGatewayProfile("chat");
  const fallbackAlias = defaultChatProfile.modelAlias || DEFAULT_MODEL_ALIAS;

  return {
    modelAlias: fallbackAlias,
    persistedAlias: input.threadModelSettings.llmModelAlias,
  };
}

export async function resolveActiveChatProfileByAlias(modelAlias: string) {
  const [row] = await db
    .select({
      gatewayConfigId: modelGatewayProfiles.gatewayConfigId,
      modelAlias: modelGatewayProfiles.modelAlias,
    })
    .from(modelGatewayProfiles)
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
