import type Stripe from "stripe";
import type { Pool } from "pg";
export interface StripeInboxStore {
  withLock<T>(orderId: string, run: () => Promise<T>): Promise<T>;
  pendingEvents(testMode: boolean): Promise<Stripe.Event[]>;
}
export class PostgresStripeInboxStore implements StripeInboxStore {
  constructor(private readonly pool: Pool) {}
  async withLock<T>(orderId: string, run: () => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query(
        "select pg_advisory_lock(hashtextextended($1, 0))",
        [`stripe:${orderId}`],
      );
      try {
        return await run();
      } finally {
        await connection.query(
          "select pg_advisory_unlock(hashtextextended($1, 0))",
          [`stripe:${orderId}`],
        );
      }
    } finally {
      connection.release();
    }
  }
  async pendingEvents(testMode: boolean): Promise<Stripe.Event[]> {
    const rows = await this.pool.query(
      `select payload from billing_webhook_events where provider='stripe' and status in ('received','failed') and payload->>'livemode'=$1 and (status='received' or updated_at < now() - interval '30 seconds') order by case when status='received' then 0 else 1 end, updated_at asc limit 100`,
      [String(!testMode)],
    );
    return rows.rows.map((row) => row.payload as Stripe.Event);
  }
}
