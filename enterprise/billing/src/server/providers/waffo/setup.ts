import {
  BillingPeriod,
  TaxCategory,
  type WaffoPancake,
} from "@waffo/pancake-ts";
import { BillingError } from "../../errors";
import type { BillingRuntimeConfig } from "../../types";
import { centsToDisplay } from "./client";
import type { WaffoSettings, WaffoStateStore } from "./state";

export function waffoCatalogProducts(config: BillingRuntimeConfig) {
  return [
    {
      key: "individual_pro:monthly",
      name: "SourceWeft Pro Monthly",
      amount: config.catalog.individualProMonthlyAmountCents,
      period: BillingPeriod.Monthly,
    },
    {
      key: "individual_pro:yearly",
      name: "SourceWeft Pro Yearly",
      amount: config.catalog.individualProYearlyAmountCents,
      period: BillingPeriod.Yearly,
    },
    ...(config.teamBillingEnabled
      ? [
          {
            key: "team_standard:monthly",
            name: "SourceWeft Team Monthly",
            amount: config.catalog.teamStandardMonthlyAmountCents * 2,
            period: BillingPeriod.Monthly,
          },
          {
            key: "team_standard:yearly",
            name: "SourceWeft Team Yearly",
            amount: config.catalog.teamStandardYearlyAmountCents * 2,
            period: BillingPeriod.Yearly,
          },
        ]
      : []),
    {
      key: "credit_topup",
      name: "SourceWeft Credits",
      amount: config.catalog.creditTopupAmountCents,
    },
    {
      key: "page_topup",
      name: "SourceWeft Pages",
      amount: config.catalog.pageTopupAmountCents,
    },
  ];
}
export async function setupWaffoCatalog(input: {
  client: WaffoPancake;
  config: BillingRuntimeConfig;
  state: WaffoStateStore;
  storeId?: string;
}): Promise<WaffoSettings> {
  const { client, config, state } = input;
  // Publishing is a separate production action. This bootstrap is deliberately test-only.
  if (config.waffo.environment !== "test")
    throw new BillingError(
      "WAFFO_TEST_SETUP_ONLY",
      400,
      "Run initial Waffo catalog setup with a TEST API Key",
    );
  return state.withLock(`setup:${config.waffo.merchantId}:test`, async () => {
    const existing = await state.getSettings(config.waffo.merchantId, "test");
    const response = await client.graphql.query<{
      stores: Array<{ id: string; name: string; status: string }>;
    }>({ query: "query { stores { id name status } }" });
    if (response.errors?.length || !response.data)
      throw new BillingError(
        "WAFFO_STORES_QUERY_FAILED",
        502,
        "Unable to list Waffo stores",
      );
    const stores = response.data.stores;
    if (existing && input.storeId && input.storeId !== existing.storeId)
      throw new BillingError(
        "WAFFO_STORE_ALREADY_BOUND",
        409,
        "Migrate existing billing records before changing the configured Waffo store",
      );
    let storeId = input.storeId ?? existing?.storeId;
    if (
      storeId &&
      !stores.some((store) => store.id === storeId && store.status === "active")
    )
      throw new BillingError(
        "WAFFO_STORE_INVALID",
        400,
        "Selected store is not an active store owned by this merchant",
      );
    if (!storeId && stores.length > 1)
      throw new BillingError(
        "WAFFO_STORE_SELECTION_REQUIRED",
        409,
        "Choose a store with --store-id before creating products",
        { stores: stores.map(({ id, name }) => ({ id, name })) },
      );
    if (!storeId && stores.length === 1) {
      if (stores[0]!.status !== "active")
        throw new BillingError(
          "WAFFO_STORE_INACTIVE",
          409,
          "Activate the existing Waffo store before setup",
        );
      storeId = stores[0]!.id;
    }
    if (!storeId)
      storeId = (await client.stores.create({ name: "SourceWeft" })).store.id;
    const remote = await client.graphql.query<{
      onetimeProducts: Array<{ id: string; metadata: string; status: string }>;
      subscriptionProducts: Array<{
        id: string;
        metadata: string;
        status: string;
        billingPeriod: string;
      }>;
    }>({
      query:
        "query($storeId: String!) { onetimeProducts(storeId: $storeId) { id metadata status } subscriptionProducts(storeId: $storeId) { id metadata status billingPeriod } }",
      variables: { storeId },
    });
    if (remote.errors?.length || !remote.data)
      throw new BillingError(
        "WAFFO_PRODUCTS_QUERY_FAILED",
        502,
        "Unable to inspect existing Waffo products",
      );
    const products: Record<string, string> = {};
    for (const item of waffoCatalogProducts(config)) {
      const candidates = (
        item.period
          ? remote.data.subscriptionProducts
          : remote.data.onetimeProducts
      ).filter((product) => {
        const metadata =
          typeof product.metadata === "string"
            ? JSON.parse(product.metadata || "{}")
            : product.metadata;
        return (
          metadata?.sourceweftProductKey === item.key &&
          product.status === "active"
        );
      });
      if (candidates.length > 1)
        throw new BillingError(
          "WAFFO_PRODUCT_AMBIGUOUS",
          409,
          `More than one active Waffo product is mapped to ${item.key}`,
        );
      if (
        item.period &&
        candidates[0] &&
        (!("billingPeriod" in candidates[0]) ||
          candidates[0].billingPeriod !== item.period)
      )
        throw new BillingError(
          "WAFFO_PRODUCT_PERIOD_MISMATCH",
          409,
          `Existing Waffo product has the wrong billing period for ${item.key}`,
        );
      if (candidates[0]) products[item.key] = candidates[0].id;
      else {
        const params = {
          storeId,
          name: item.name,
          description:
            item.key === "credit_topup"
              ? `${config.catalog.creditTopupUnitAmount} credits per pack`
              : item.key === "page_topup"
                ? `${config.catalog.pageTopupUnitAmount} pages per pack`
                : item.name,
          prices: {
            USD: {
              amount: centsToDisplay(item.amount),
              taxCategory: TaxCategory.SaaS,
            },
          },
          metadata: { sourceweftProductKey: item.key },
        };
        const created = item.period
          ? await client.subscriptionProducts.create({
              ...params,
              billingPeriod: item.period,
            })
          : await client.onetimeProducts.create(params);
        products[item.key] = created.product.id;
      }
      // Persist each successful mapping so an interrupted setup can resume.
      await state.saveSettings({
        merchantId: config.waffo.merchantId,
        environment: "test",
        storeId,
        products,
      });
    }
    return {
      merchantId: config.waffo.merchantId,
      environment: "test",
      storeId,
      products,
    };
  });
}
