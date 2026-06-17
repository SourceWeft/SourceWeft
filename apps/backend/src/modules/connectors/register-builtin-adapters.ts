import {
  createPackageAgentToolDefs,
  createPackageConnectorAdapters,
} from "./package-adapters";
import { connectorRegistry } from "./registry";
import { registerAgentTools } from "@sourceweft/agent-tool-registry";

let registered = false;

export function registerBuiltinConnectorAdapters() {
  if (registered) {
    return;
  }
  for (const adapter of createPackageConnectorAdapters()) {
    connectorRegistry.register(adapter);
  }
  registerAgentTools(createPackageAgentToolDefs());
  registered = true;
}
