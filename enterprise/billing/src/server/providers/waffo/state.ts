import type { Pool } from "pg";
import type { WebhookEvent } from "@waffo/pancake-ts";

export type WaffoEnvironment = "test" | "prod";
export type WaffoSettings = {
  merchantId: string;
  environment: WaffoEnvironment;
  storeId: string;
  products: Record<string, string>;
};
export interface WaffoStateStore {
  getSettings(
    merchantId: string,
    environment: WaffoEnvironment,
  ): Promise<WaffoSettings | null>;
  saveSettings(settings: WaffoSettings): Promise<void>;
  withLock<T>(key: string, run: () => Promise<T>): Promise<T>;
  pendingEvents(settings: WaffoSettings): Promise<WebhookEvent[]>;
}

export class PostgresWaffoStateStore implements WaffoStateStore {
  constructor(private readonly pool: Pool) {}
  async getSettings(merchantId: string, environment: WaffoEnvironment) {
    const result = await this.pool.query(
      "select merchant_id, environment, store_id, products from billing_provider_settings where provider='waffo' and merchant_id=$1 and environment=$2",
      [merchantId, environment],
    );
    const row = result.rows[0];
    return row
      ? ({
          merchantId: row.merchant_id,
          environment: row.environment,
          storeId: row.store_id,
          products: row.products,
        } as WaffoSettings)
      : null;
  }
  async saveSettings(settings: WaffoSettings) {
    await this.pool.query(
      `insert into billing_provider_settings (id,provider,merchant_id,environment,store_id,products)
       values ($1,'waffo',$2,$3,$4,$5::jsonb)
       on conflict (provider,merchant_id,environment) do update
       set store_id=excluded.store_id, products=excluded.products, updated_at=now()`,
      [
        `waffo:${settings.merchantId}:${settings.environment}`,
        settings.merchantId,
        settings.environment,
        settings.storeId,
        JSON.stringify(settings.products),
      ],
    );
  }
  async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query(
        "select pg_advisory_lock(hashtextextended($1, 0))",
        [`waffo:${key}`],
      );
      try {
        return await run();
      } finally {
        await connection.query(
          "select pg_advisory_unlock(hashtextextended($1, 0))",
          [`waffo:${key}`],
        );
      }
    } finally {
      connection.release();
    }
  }
  async pendingEvents(settings: WaffoSettings): Promise<WebhookEvent[]> {
    const result = await this.pool.query(
      `select payload from billing_webhook_events
       where provider='waffo' and status in ('received','failed')
         and payload->>'mode'=$1 and payload->>'storeId'=$2
         and metadata->>'waffoMerchantId'=$3
         and (status='received' or updated_at < now() - interval '30 seconds')
       order by case when status='received' then 0 else 1 end, updated_at asc limit 100`,
      [settings.environment, settings.storeId, settings.merchantId],
    );
    return result.rows.map((row) => row.payload as WebhookEvent);
  }
}
