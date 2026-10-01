import { enqueueMcpOverviews } from "../../modules/market/overview/queue";
import { config } from "../../shared/config";

/**
 * Queue the next batch of MCP overviews: versions whose README has settled
 * and that have no overview for their current input. Nothing is queued while
 * the system model is not ready. Only queues: the worker calls the model.
 *
 * The pace is `config.market.overviewBatchSize` versions per run, and the
 * scheduler runs this every `config.market.overviewIntervalMs`
 * (`MCP_OVERVIEW_BATCH_SIZE` and `MCP_OVERVIEW_INTERVAL_MS`; 20 every
 * 5 minutes by default), so a large catalog is worked through over days
 * rather than in one burst on the system model's key, and a backlog can be
 * worked through faster for a while without a release.
 */
export async function scheduleMcpOverviews(): Promise<void> {
  await enqueueMcpOverviews(undefined, undefined, {
    batchSize: config.market.overviewBatchSize,
  });
}
