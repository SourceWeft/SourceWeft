/**
 * cloudflare-sandbox-bridge — Cloudflare Sandbox Worker
 *
 * deploy.sh copies this over the stock scaffold's src/index.ts. It is the
 * template's thin wrapper around the bridge from @cloudflare/sandbox/bridge,
 * with one change: the warm pool's ceiling comes from WARM_POOL_MAX_INSTANCES.
 */

import { WarmPool as StockWarmPool, bridge, type WarmPoolConfig } from '@cloudflare/sandbox/bridge';

// Re-export Sandbox so Wrangler can wire up the Durable Object binding.
export { Sandbox } from '@cloudflare/sandbox';

/**
 * The stock pool persists the lowest ceiling it has ever been given or learned
 * from a capacity error: configure() stores min(stored, WARM_POOL_MAX_INSTANCES),
 * and only the probe that runs while WARM_POOL_TARGET > 0 clears it. With no warm
 * containers configured, a ceiling stored under the template's max_instances: 3
 * therefore survived raising max_instances to 50, and the fourth concurrent
 * sandbox kept getting "instance limit reached (3/3)".
 *
 * configure() runs on every request, so resetting the ceiling to the configured
 * value there makes each deploy's number authoritative. A genuine Cloudflare
 * capacity error still fails the container start that hits it.
 */
export class WarmPool extends StockWarmPool {
  override async configure(config: WarmPoolConfig): Promise<void> {
    await super.configure(config);
    const maxInstances = config.maxInstances ?? 0;
    if (maxInstances > 0) {
      // `private` in the SDK's typings, a plain field at runtime.
      (this as unknown as { knownMaxInstances: number | null }).knownMaxInstances = maxInstances;
      await this.ctx.storage.put('knownMaxInstances', maxInstances);
    }
  }
}

export default bridge({
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response('OK');
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {}
});
