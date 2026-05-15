import { notionAdapter } from "./adapters/notion";
import { connectorRegistry } from "./registry";

let registered = false;

export function registerBuiltinConnectorAdapters() {
  if (registered) {
    return;
  }
  connectorRegistry.register(notionAdapter);
  registered = true;
}

