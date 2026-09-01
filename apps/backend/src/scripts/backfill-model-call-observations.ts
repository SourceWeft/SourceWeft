import "dotenv/config";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { closeDatabase, db, llmGenerations } from "@sourceweft/db";

const BATCH_SIZE = 250;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function parseCapturedRecord(value: unknown) {
  const direct = record(value);
  if (!direct) {
    return undefined;
  }
  if (typeof direct.preview !== "string") {
    return direct;
  }
  try {
    return record(JSON.parse(direct.preview));
  } catch {
    return direct;
  }
}

function resolvedModel(providerFields: unknown) {
  const fields = parseCapturedRecord(providerFields);
  for (const key of ["model_name", "model"]) {
    const value = fields?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function costClassification(input: {
  providerCostUsd: string | null;
  usageJson: unknown;
  metadataJson: unknown;
}) {
  if (input.providerCostUsd === null) {
    return {};
  }
  const usage = record(input.usageJson);
  const metadata = record(input.metadataJson);
  const source = metadata?.costSource;
  if (
    source === "provider_actual" ||
    usage?.providerCostSource === "provider_inline"
  ) {
    return {
      providerCostInlineUsd: input.providerCostUsd,
      providerCostSource: "provider_inline",
      providerCostStatus: "inline",
      costCurrency: "USD",
    };
  }
  if (source === "price_book") {
    return {
      providerCostSource: "price_book",
      providerCostStatus: "estimated",
      costCurrency: "USD",
    };
  }
  return {
    providerCostSource: "legacy",
    providerCostStatus: "legacy",
    costCurrency: "USD",
  };
}

async function run() {
  let cursor: string | undefined;
  let updated = 0;

  while (true) {
    const rows = await db
      .select()
      .from(llmGenerations)
      .where(
        cursor
          ? and(
              isNull(llmGenerations.normalizationJson),
              gt(llmGenerations.id, cursor),
            )
          : isNull(llmGenerations.normalizationJson),
      )
      .orderBy(asc(llmGenerations.id))
      .limit(BATCH_SIZE);
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const usage = record(row.usageJson);
      const metadata = record(row.metadataJson);
      await db
        .update(llmGenerations)
        .set({
          resolvedProviderModel:
            row.resolvedProviderModel ?? resolvedModel(row.providerFieldsJson),
          profileAlias:
            row.profileAlias ??
            (typeof metadata?.profileAlias === "string"
              ? metadata.profileAlias
              : undefined),
          gatewayConfigId:
            row.gatewayConfigId ??
            (typeof metadata?.gatewayConfigId === "string"
              ? metadata.gatewayConfigId
              : undefined),
          reasoningTokens:
            row.reasoningTokens ?? finiteInteger(usage?.reasoningTokens),
          cacheReadTokens:
            row.cacheReadTokens ?? finiteInteger(usage?.cacheReadTokens),
          cacheWriteTokens:
            row.cacheWriteTokens ?? finiteInteger(usage?.cacheWriteTokens),
          ...costClassification({
            providerCostUsd: row.providerCostUsd,
            usageJson: row.usageJson,
            metadataJson: row.metadataJson,
          }),
          normalizationJson: {
            backfill: "2026-08-24-model-call-observation-v1",
            resolvedModelSource: resolvedModel(row.providerFieldsJson)
              ? "provider_fields"
              : null,
          },
        })
        .where(eq(llmGenerations.id, row.id));
      updated += 1;
    }
    cursor = rows.at(-1)?.id;
  }

  console.log(`Backfilled ${updated} model generation observation rows.`);
}

try {
  await run();
} finally {
  await closeDatabase();
}
