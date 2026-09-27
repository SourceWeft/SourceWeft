import { enqueueMcpOverviews } from "../../modules/market/overview/queue";

/**
 * How often MCP server AI overviews are queued: at most
 * `MCP_OVERVIEW_BATCH_SIZE` per run, so a large catalog is worked through
 * over hours rather than in one burst on the system model's key.
 */
export const MCP_OVERVIEW_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Queue the next batch of MCP overviews: versions whose README has settled
 * and that have no overview for their current input. Nothing is queued while
 * the system model is not ready. Only queues: the worker calls the model.
 */
export async function scheduleMcpOverviews(): Promise<void> {
  await enqueueMcpOverviews();
}
