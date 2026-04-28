import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../../shared/database";
import {
  modelGatewayConfigVersions,
  modelGatewayProviderConfigs,
  modelGatewayProfiles,
  modelGatewayRoutes,
} from "../../../../shared/db/schema";
import { requireContentWorkspace } from "../../content-support";
import {
  THREAD_KIND_BY_MODEL_KIND,
  type ModelProfileKind,
  type ThreadModelSettings,
} from "../model-settings";

type ThreadModelCatalogEntry = {
  kind: "llm" | "image" | "vision";
  profileAlias: string;
  modelAlias: string;
  providerName: string;
  providerKind: string;
  targetModel: string | null;
  isDefault: boolean;
  isActive: boolean;
  displayName: string;
  subtitle: string;
  badges: string[];
  pricing: Record<string, unknown> | null;
};

function dedupeByTarget<T extends {
  isDefault: boolean;
  providerName: string;
  targetModel: string | null;
  modelAlias: string;
  displayName: string;
}>(items: T[]) {
  const indexByTargetKey = new Map<string, number>();
  const deduped: T[] = [];

  for (const item of items) {
    if (item.isDefault) {
      deduped.push(item);
      continue;
    }

    const provider = item.providerName.trim().toLowerCase();
    const target = (item.targetModel ?? item.modelAlias).trim().toLowerCase();
    if (!provider || !target) {
      deduped.push(item);
      continue;
    }

    const dedupeKey = `${provider}:${target}`;
    const existingIndex = indexByTargetKey.get(dedupeKey);
    if (existingIndex === undefined) {
      indexByTargetKey.set(dedupeKey, deduped.length);
      deduped.push(item);
      continue;
    }

    const existing = deduped[existingIndex]!;
    const existingHasReadableName =
      existing.displayName.trim().toLowerCase() !==
      existing.modelAlias.trim().toLowerCase();
    const currentHasReadableName =
      item.displayName.trim().toLowerCase() !==
      item.modelAlias.trim().toLowerCase();
    if (!existingHasReadableName && currentHasReadableName) {
      deduped[existingIndex] = item;
    }
  }

  return deduped;
}

export async function listThreadModelCatalog(input: {
  workspaceId: string;
  userId: string;
}) {
  await requireContentWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  const profileKinds: ModelProfileKind[] = ["chat", "image", "vision"];
  const profileRows = await db
    .select({
      kind: modelGatewayProfiles.kind,
      profileAlias: modelGatewayProfiles.profileAlias,
      modelAlias: modelGatewayProfiles.modelAlias,
      isDefault: modelGatewayProfiles.isDefault,
      isActive: modelGatewayProfiles.isActive,
      configJson: modelGatewayProfiles.configJson,
    })
    .from(modelGatewayProfiles)
    .where(
      and(
        eq(modelGatewayProfiles.isActive, true),
        inArray(modelGatewayProfiles.kind, profileKinds),
      ),
    );

  const [activeVersion] = await db
    .select({ id: modelGatewayConfigVersions.id })
    .from(modelGatewayConfigVersions)
    .where(eq(modelGatewayConfigVersions.isActive, true))
    .limit(1);

  const routeByKindAlias = new Map<
    string,
    {
      providerName: string;
      providerKind: string;
      targetModel: string;
    }
  >();

  if (activeVersion) {
    const [routeRows, providerRows] = await Promise.all([
      db
        .select({
          routeKind: modelGatewayRoutes.routeKind,
          alias: modelGatewayRoutes.alias,
          targetProviderName: modelGatewayRoutes.targetProviderName,
          targetModel: modelGatewayRoutes.targetModel,
          priority: modelGatewayRoutes.priority,
          weight: modelGatewayRoutes.weight,
        })
        .from(modelGatewayRoutes)
        .where(
          and(
            eq(modelGatewayRoutes.configVersionId, activeVersion.id),
            eq(modelGatewayRoutes.isActive, true),
            inArray(modelGatewayRoutes.routeKind, profileKinds),
          ),
        ),
      db
        .select({
          providerName: modelGatewayProviderConfigs.providerName,
          providerKind: modelGatewayProviderConfigs.providerKind,
        })
        .from(modelGatewayProviderConfigs)
        .where(
          and(
            eq(modelGatewayProviderConfigs.configVersionId, activeVersion.id),
            eq(modelGatewayProviderConfigs.isActive, true),
          ),
        ),
    ]);

    const providerKindByName = new Map(
      providerRows.map((row) => [row.providerName, row.providerKind]),
    );

    routeRows
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return left.priority - right.priority;
        }
        return right.weight - left.weight;
      })
      .forEach((route) => {
        const key = `${route.routeKind}:${route.alias}`;
        if (routeByKindAlias.has(key)) {
          return;
        }

        routeByKindAlias.set(key, {
          providerName: route.targetProviderName,
          providerKind:
            providerKindByName.get(route.targetProviderName) ?? "unknown",
          targetModel: route.targetModel,
        });
      });
  }

  const defaults: ThreadModelSettings = {
    llmModelAlias: null,
    imageModelAlias: null,
    visionModelAlias: null,
  };

  const kinds: Record<"llm" | "image" | "vision", ThreadModelCatalogEntry[]> = {
    llm: [],
    image: [],
    vision: [],
  };

  for (const row of profileRows) {
    const profileKind = row.kind as ModelProfileKind;
    const threadKind = THREAD_KIND_BY_MODEL_KIND[profileKind];
    const route = routeByKindAlias.get(`${profileKind}:${row.modelAlias}`);
    const configJson =
      row.configJson && typeof row.configJson === "object"
        ? (row.configJson as Record<string, unknown>)
        : {};
    const isGlobalDefaultAlias =
      row.modelAlias === "chat-default" ||
      row.modelAlias === "image-default" ||
      row.modelAlias === "vision-default";
    const displayName = isGlobalDefaultAlias
      ? "Auto (Default)"
      : typeof configJson.displayName === "string" &&
          configJson.displayName.trim().length > 0
        ? configJson.displayName.trim()
        : row.modelAlias;
    const subtitle = isGlobalDefaultAlias
      ? "Global models"
      : typeof configJson.subtitle === "string" &&
          configJson.subtitle.trim().length > 0
        ? configJson.subtitle.trim()
        : (route?.targetModel ?? row.modelAlias);
    const badges = Array.isArray(configJson.badges)
      ? configJson.badges.filter(
          (badge): badge is string =>
            typeof badge === "string" && badge.trim().length > 0,
        )
      : [];
    const pricing =
      typeof configJson.price_source === "string" ? configJson : null;

    kinds[threadKind].push({
      kind: threadKind,
      profileAlias: row.profileAlias,
      modelAlias: row.modelAlias,
      providerName: route?.providerName ?? "unknown",
      providerKind: route?.providerKind ?? "unknown",
      targetModel: route?.targetModel ?? null,
      isDefault: row.isDefault,
      isActive: row.isActive,
      displayName,
      subtitle,
      badges,
      pricing,
    });

    if (row.isDefault) {
      if (threadKind === "llm") {
        defaults.llmModelAlias = row.modelAlias;
      }
      if (threadKind === "image") {
        defaults.imageModelAlias = row.modelAlias;
      }
      if (threadKind === "vision") {
        defaults.visionModelAlias = row.modelAlias;
      }
    }
  }

  kinds.llm = dedupeByTarget(kinds.llm);
  kinds.image = dedupeByTarget(kinds.image);
  kinds.vision = dedupeByTarget(kinds.vision);

  const sorter = (
    left: { isDefault: boolean; displayName: string },
    right: { isDefault: boolean; displayName: string },
  ) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return left.displayName.localeCompare(right.displayName);
  };
  kinds.llm.sort(sorter);
  kinds.image.sort(sorter);
  kinds.vision.sort(sorter);

  return {
    defaults,
    kinds,
  };
}
