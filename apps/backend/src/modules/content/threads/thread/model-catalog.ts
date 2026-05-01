import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../../shared/database";
import {
  modelGatewayConfigVersions,
  modelGatewayConfigs,
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
  isDefault: boolean;
  isActive: boolean;
  displayName: string;
  subtitle: string;
  badges: string[];
  pricing: Record<string, unknown> | null;
  capabilities?: {
    supportsThinking: boolean;
    supportedParameters: string[];
    supportedEfforts: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
    reasoning: boolean;
    reasoningEffort: boolean;
    includeReasoning: boolean;
    supportSources: string[];
  };
};

type ThreadModelCapabilities = NonNullable<ThreadModelCatalogEntry["capabilities"]>;

type CatalogPricing = NonNullable<ThreadModelCatalogEntry["pricing"]>;

const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

function normalizeSupportedEfforts(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as Array<(typeof REASONING_EFFORTS)[number]>;
  }

  return Array.from(
    new Set(
      value
        .filter((effort): effort is string => typeof effort === "string")
        .map((effort) => effort.trim().toLowerCase())
        .filter((effort): effort is (typeof REASONING_EFFORTS)[number] =>
          REASONING_EFFORTS.includes(effort as (typeof REASONING_EFFORTS)[number])
        ),
    ),
  );
}

function resolveReasoningCapabilities(input: {
  configJson: Record<string, unknown>;
}): ThreadModelCapabilities {
  const { configJson } = input;
  const supportedParameters = Array.isArray(configJson.supportedParameters)
    ? configJson.supportedParameters
        .filter((parameter): parameter is string => typeof parameter === "string")
        .map((parameter) => parameter.trim().toLowerCase())
        .filter((parameter) => parameter.length > 0)
    : [];

  const reasoning = supportedParameters.includes("reasoning");
  const reasoningEffort = supportedParameters.includes("reasoning_effort");
  const includeReasoning = supportedParameters.includes("include_reasoning");
  const supportedEfforts = normalizeSupportedEfforts(configJson.supportedEfforts);
  const providerCatalogSource =
    typeof configJson.providerCatalogSource === "string"
      ? configJson.providerCatalogSource
      : null;
  const supportSources = [
    ...(supportedParameters.length > 0 ? [providerCatalogSource ?? "config"] : []),
  ];
  return {
    supportsThinking: reasoning || reasoningEffort || includeReasoning,
    supportedParameters,
    supportedEfforts,
    reasoning,
    reasoningEffort,
    includeReasoning,
    supportSources: Array.from(new Set(supportSources)),
  };
}

function resolveCatalogPricing(configJson: Record<string, unknown>): CatalogPricing | null {
  const priceSource = configJson.price_source;
  if (typeof priceSource !== "string") {
    return null;
  }

  return {
    input_cost_per_token: configJson.input_cost_per_token ?? null,
    output_cost_per_token: configJson.output_cost_per_token ?? null,
    cache_read_input_token_cost: configJson.cache_read_input_token_cost ?? null,
    cache_creation_input_token_cost:
      configJson.cache_creation_input_token_cost ?? null,
    output_cost_per_reasoning_token:
      configJson.output_cost_per_reasoning_token ?? null,
    price_source: priceSource,
    price_updated_at: configJson.price_updated_at ?? null,
  };
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
      hasGlobalApiKey: boolean;
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
          apiKeyEncrypted: modelGatewayConfigs.apiKeyEncrypted,
        })
        .from(modelGatewayProviderConfigs)
        .leftJoin(
          modelGatewayConfigs,
          eq(modelGatewayConfigs.id, modelGatewayProviderConfigs.gatewayConfigId),
        )
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
    const providerHasGlobalApiKeyByName = new Map(
      providerRows.map((row) => [
        row.providerName,
        typeof row.apiKeyEncrypted === "string" && row.apiKeyEncrypted.length > 0,
      ]),
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
          hasGlobalApiKey:
            providerHasGlobalApiKeyByName.get(route.targetProviderName) ?? false,
        });
      });
  }

  const defaults: ThreadModelSettings = {
    llmProfileAlias: null,
    imageProfileAlias: null,
    visionProfileAlias: null,
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
    const route = routeByKindAlias.get(`${profileKind}:${row.profileAlias}`);
    if (!route?.hasGlobalApiKey) {
      continue;
    }
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
        : row.modelAlias;
    const badges = Array.isArray(configJson.badges)
      ? configJson.badges.filter(
          (badge): badge is string =>
            typeof badge === "string" && badge.trim().length > 0,
        )
      : [];
    const pricing = resolveCatalogPricing(configJson);
    const directCapabilities = resolveReasoningCapabilities({
      configJson,
    });

    kinds[threadKind].push({
      kind: threadKind,
      profileAlias: row.profileAlias,
      modelAlias: row.modelAlias,
      isDefault: row.isDefault,
      isActive: row.isActive,
      displayName,
      subtitle,
      badges,
      pricing,
      capabilities: directCapabilities,
    });

    if (row.isDefault) {
      if (threadKind === "llm") {
        defaults.llmProfileAlias = row.profileAlias;
        defaults.llmModelAlias = row.modelAlias;
      }
      if (threadKind === "image") {
        defaults.imageProfileAlias = row.profileAlias;
        defaults.imageModelAlias = row.modelAlias;
      }
      if (threadKind === "vision") {
        defaults.visionProfileAlias = row.profileAlias;
        defaults.visionModelAlias = row.modelAlias;
      }
    }
  }

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
