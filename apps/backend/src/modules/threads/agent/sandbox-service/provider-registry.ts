import { createDaytonaSandboxProviderFactory } from "@sourceweft/sandbox-provider-daytona";
import { config } from "../../../../shared/config";
import type { SandboxProviderFactory } from "@sourceweft/builtin-tool-sandbox";

const factories = new Map<string, SandboxProviderFactory>();

function registerBuiltinProviders() {
  factories.set(
    "daytona",
    createDaytonaSandboxProviderFactory({
      apiUrl: config.sandbox.daytona.apiUrl,
      apiKey: config.sandbox.daytona.apiKey,
      snapshot: config.sandbox.daytona.snapshot,
      image: config.sandbox.daytona.image,
      maxOutputChars: config.sandbox.maxOutputChars,
    }),
  );
}
registerBuiltinProviders();

export function registerSandboxProviderFactory(
  factory: SandboxProviderFactory,
) {
  if (factories.has(factory.id)) {
    throw new Error(`Sandbox provider '${factory.id}' is already registered`);
  }
  factories.set(factory.id, factory);
}

export function getSandboxProviderFactory(providerId: string) {
  registerBuiltinProviders();
  return factories.get(providerId) ?? null;
}

export function listSandboxProviderFactories() {
  registerBuiltinProviders();
  return Array.from(factories.values());
}
