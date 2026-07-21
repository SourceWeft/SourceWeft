import type { SandboxProviderFactory } from "@sourceweft/builtin-tool-sandbox";
import { collectCapabilitySandboxProviders } from "../../../capabilities/host-services";
import type { CapabilityHostServiceSources } from "../../../capabilities/host-services";
import { config } from "../../../../shared/config";

/**
 * The set of sandbox providers this deployment can select from.
 *
 * It used to be a map with one hardcoded entry: the registry imported the
 * Daytona package and constructed it from a `config.sandbox.daytona.*` block.
 * `registerSandboxProviderFactory` existed alongside it and nothing outside
 * this file's own test ever called it — a socket with nothing plugged in and
 * one provider soldered on. Adding a second provider meant editing the host.
 *
 * Now the providers arrive the way every other host service does: a capability
 * declares `sandbox_provider` in its manifest and exports
 * `createSandboxProviderFactories`. Nothing below names a provider, so adding
 * one is a package plus a manifest, with no change here.
 *
 * The only value the host still supplies is `maxOutputChars`, which is a
 * deployment-wide output budget rather than any provider's setting.
 */

let initialization: Promise<ReadonlyMap<string, SandboxProviderFactory>> | null =
  null;
let factories: ReadonlyMap<string, SandboxProviderFactory> | null = null;

/**
 * Discovers the installed providers, once per process.
 *
 * Idempotent and memoised, so every caller can `await` it unconditionally
 * instead of depending on a startup ordering nobody can see from the call site.
 * That is what makes the synchronous lookup below safe: a caller cannot reach
 * it before discovery has finished, because reaching it means having awaited
 * this first.
 *
 * A failure is not cached: a transient discovery error would otherwise disable
 * the sandbox for the lifetime of the process.
 */
export function initializeSandboxProviderRegistry(
  sources?: CapabilityHostServiceSources,
): Promise<ReadonlyMap<string, SandboxProviderFactory>> {
  initialization ??= collectCapabilitySandboxProviders(
    { limits: { maxOutputChars: config.sandbox.maxOutputChars } },
    sources ?? {},
  )
    .then((collected) => {
      factories = collected;
      return collected;
    })
    .catch((error: unknown) => {
      initialization = null;
      throw error;
    });
  return initialization;
}

export class SandboxProviderRegistryNotReadyError extends Error {
  constructor(providerId: string) {
    super(
      `Sandbox provider '${providerId}' was looked up before the provider ` +
        `registry finished discovering capabilities. Await ` +
        `initializeSandboxProviderRegistry() first — returning null here would ` +
        `be indistinguishable from the provider not being installed.`,
    );
    this.name = "SandboxProviderRegistryNotReadyError";
  }
}

/**
 * The factory for a provider id, or null when no installed capability supplies
 * it. Null keeps its original meaning — "nothing registered under this id" —
 * which the sandbox service turns into a `SANDBOX_RUNTIME_UNAVAILABLE` error
 * naming the id, and which the startup warning reports as
 * `provider:<id>` missing.
 *
 * Being called before discovery finished is a different fault and throws
 * rather than returning null, so a startup-ordering bug can never masquerade
 * as an uninstalled provider.
 */
export function getSandboxProviderFactory(
  providerId: string,
): SandboxProviderFactory | null {
  if (!factories) {
    throw new SandboxProviderRegistryNotReadyError(providerId);
  }
  return factories.get(providerId) ?? null;
}
