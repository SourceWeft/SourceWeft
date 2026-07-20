import { registerAgentTools } from "@sourceweft/agent-tool-registry";
import { collectCapabilityConnectorContributions } from "../capabilities/host-services";
import { logger } from "../../shared/logger";
import { connectorRegistry } from "./registry";

/**
 * Registers every connector a capability contributes.
 *
 * Which connectors exist is a manifest fact, so discovering them is async and
 * this cannot be a bare top-level call any more. The promise is created once at
 * import time and awaited by each process entrypoint before it serves traffic;
 * `connectorAdaptersReady()` is the seam anything else (a test, a script) uses
 * to wait.
 */
let registration: Promise<void> | null = null;

export function registerBuiltinConnectorAdapters(): Promise<void> {
  registration ??= register();
  return registration;
}

/** Awaits the registration kicked off at import time. */
export function connectorAdaptersReady(): Promise<void> {
  return registerBuiltinConnectorAdapters();
}

/** Test seam: forget the registration so the next call rediscovers. */
export function resetBuiltinConnectorAdapterRegistration() {
  registration = null;
}

async function register(): Promise<void> {
  try {
    const { adapters, agentToolDefs } =
      await collectCapabilityConnectorContributions();
    for (const adapter of adapters) {
      connectorRegistry.register(adapter);
    }
    registerAgentTools(agentToolDefs);
  } catch (error) {
    // A failure here must not take the process down at import time: the
    // symptom is connectors being unavailable, which the registry already
    // reports per request.
    registration = null;
    logger.error("connector_adapter_registration_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
