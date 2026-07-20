import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import { resolveCapabilityWebProvider } from "../capabilities/host-services";

/**
 * The host's web provider, supplied by whichever capability declares the
 * `web_provider` host service.
 *
 * The backend used to construct a named vendor's client here out of its own
 * config key. It now asks the capability layer, so the provider — and the API
 * key that configures it — can be swapped or removed without a host edit.
 * Resolution is async because it loads a capability entry module; null still
 * means "web is unavailable", exactly as an unset key did before.
 */
export function createDefaultWebProvider(options?: {
  fetchTimeoutMs?: number;
}): Promise<AgentToolWebProvider | null> {
  return resolveCapabilityWebProvider(options);
}
