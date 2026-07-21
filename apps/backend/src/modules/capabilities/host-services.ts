import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import type { DiscoveredCapabilityRecord } from "@sourceweft/capability-runtime";
import type {
  CreateSandboxProviderFactories,
  SandboxProviderFactory,
  SandboxProviderHostLimits,
} from "@sourceweft/builtin-tool-sandbox";
import type { AgentToolWebProvider } from "@sourceweft/contracts/agent-tools";
import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CapabilityHostServiceModule,
} from "@sourceweft/contracts/capability-host-services";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { listCapabilityRecords } from "../threads/turn/capability-command-workflows";
import { loadCapabilityEntryModule } from "./entry-module-loader";

/**
 * Collects the host-level services capabilities supply.
 *
 * This is the connector/web-provider twin of `createCapabilityAgentToolsForTurn`
 * and `discoverDeliverablePipelines`: iterate capability records, load the entry
 * module of each record that declares the service, call whatever factory the
 * module exports. Nothing here names a package, a vendor, or a connector type —
 * removing a capability removes its service, it does not break this file.
 *
 * Declaration is read from the manifest, not guessed from exports, so a package
 * that merely happens to export a matching symbol is not silently promoted into
 * a host dependency:
 *  - connector adapters: any capability contributing `connectors`
 *  - web provider: any capability listing `web_provider` in `hostServices`
 *  - sandbox providers: any capability listing `sandbox_provider`
 */

/**
 * The environment lent to capability host factories.
 *
 * `process.env` is passed through by name rather than mirrored into
 * `shared/config`, because every name a capability needs is the capability's
 * own. `NOTION_CLIENT_ID` in the host's config object was a second place that
 * had to be edited whenever a connector was added or removed.
 */
export function createCapabilityHostEnvironment(): CapabilityHostEnvironment {
  return {
    baseUrl: config.auth.baseUrl,
    get: (name: string) => process.env[name],
  };
}

/**
 * Test seams. Both default to the real discovery and the real module loader;
 * tests inject a synthetic capability instead of installing one, which is the
 * only way to exercise this loop without depending on whichever real
 * capabilities happen to be present.
 */
export type CapabilityHostServiceSources = {
  readonly recordsProvider?: () => Promise<
    readonly DiscoveredCapabilityRecord[]
  >;
  readonly loadModule?: (
    record: DiscoveredCapabilityRecord,
  ) => Promise<unknown>;
};

async function recordsDeclaring(
  predicate: (record: DiscoveredCapabilityRecord) => boolean,
  sources: CapabilityHostServiceSources,
): Promise<readonly DiscoveredCapabilityRecord[]> {
  const records = await (sources.recordsProvider ?? listCapabilityRecords)();
  return records.filter(predicate);
}

function moduleOf(module: unknown): CapabilityHostServiceModule {
  return (module ?? {}) as CapabilityHostServiceModule;
}

/**
 * Raised when two capabilities claim the same sandbox provider id.
 *
 * Loud on purpose. The host selects a provider by id, so a silent
 * last-one-wins would mean the deployment runs commands on a provider nobody
 * chose — with the same id, the same logs, and no way to tell from the outside
 * which one answered.
 */
export class DuplicateSandboxProviderIdError extends Error {
  constructor(
    readonly providerId: string,
    readonly capabilityIds: readonly string[],
  ) {
    super(
      `Two capabilities supply the sandbox provider id '${providerId}': ` +
        `${capabilityIds.join(", ")}. Provider ids are how the host selects a ` +
        `provider, so they must be unique across installed capabilities.`,
    );
    this.name = "DuplicateSandboxProviderIdError";
  }
}

/**
 * Every sandbox provider the installed capabilities supply, indexed by id.
 *
 * Collect-many, not resolve-one: `config.sandbox.provider` names which provider
 * a deployment runs on, so all of them have to coexist in the map for that
 * choice to be meaningful. This is the whole reason the registry is a socket
 * rather than a hardcoded import — installing a second provider capability adds
 * an entry here and changes nothing in the host.
 *
 * `limits` carries the host-owned, vendor-neutral budget every provider is
 * built against. Everything else a provider needs — endpoints, keys, image
 * names — it reads for itself from the capability host environment.
 */
export async function collectCapabilitySandboxProviders(
  input: { readonly limits: SandboxProviderHostLimits },
  sources: CapabilityHostServiceSources = {},
): Promise<ReadonlyMap<string, SandboxProviderFactory>> {
  const env = createCapabilityHostEnvironment();
  const records = await recordsDeclaring(
    (record) => record.manifest.hostServices.includes("sandbox_provider"),
    sources,
  );
  const load = sources.loadModule ?? loadCapabilityEntryModule;

  const factories = new Map<string, SandboxProviderFactory>();
  const declaredBy = new Map<string, string>();

  for (const record of records) {
    const module = (await load(record)) as {
      createSandboxProviderFactories?: CreateSandboxProviderFactories;
    } | null;
    const factory = module?.createSandboxProviderFactories;
    if (!factory) {
      logger.warn("capability_sandbox_provider_factory_missing", {
        capabilityId: record.manifest.id,
        packageName: record.packageName,
      });
      continue;
    }
    for (const supplied of await factory({ env, limits: input.limits })) {
      const owner = declaredBy.get(supplied.id);
      if (owner) {
        throw new DuplicateSandboxProviderIdError(supplied.id, [
          owner,
          record.manifest.id,
        ]);
      }
      declaredBy.set(supplied.id, record.manifest.id);
      factories.set(supplied.id, supplied);
    }
  }

  return factories;
}

/**
 * Every connector adapter and connector agent tool the installed capabilities
 * contribute. Empty when no capability contributes a connector.
 */
export async function collectCapabilityConnectorContributions(
  sources: CapabilityHostServiceSources = {},
): Promise<CapabilityConnectorContribution> {
  const env = createCapabilityHostEnvironment();
  const adapters: CapabilityConnectorContribution["adapters"][number][] = [];
  const agentToolDefs: CapabilityConnectorContribution["agentToolDefs"][number][] =
    [];

  const records = await recordsDeclaring(
    (record) =>
      getCapabilityContributions(record.manifest).connectors.length > 0,
    sources,
  );
  const load = sources.loadModule ?? loadCapabilityEntryModule;

  for (const record of records) {
    const factory = moduleOf(await load(record)).createConnectorAdapters;
    if (!factory) {
      logger.warn("capability_connector_factory_missing", {
        capabilityId: record.manifest.id,
        packageName: record.packageName,
      });
      continue;
    }
    const contribution = await factory({ env });
    adapters.push(...contribution.adapters);
    agentToolDefs.push(...contribution.agentToolDefs);
  }

  return { adapters, agentToolDefs };
}

/**
 * The web provider a capability supplies, or null when none is installed or the
 * installed one is unconfigured. Null is the host's normal "web tools
 * unavailable" state, not an error.
 *
 * The first declaring capability wins; a second one is reported and ignored,
 * because two providers answering the same port silently is worse than a loud
 * log line.
 */
export async function resolveCapabilityWebProvider(
  input?: { fetchTimeoutMs?: number },
  sources: CapabilityHostServiceSources = {},
): Promise<AgentToolWebProvider | null> {
  const env = createCapabilityHostEnvironment();
  const records = await recordsDeclaring(
    (record) => record.manifest.hostServices.includes("web_provider"),
    sources,
  );
  const load = sources.loadModule ?? loadCapabilityEntryModule;

  let resolved: AgentToolWebProvider | null = null;
  for (const record of records) {
    const factory = moduleOf(await load(record)).createHostWebProvider;
    if (!factory) {
      logger.warn("capability_web_provider_factory_missing", {
        capabilityId: record.manifest.id,
        packageName: record.packageName,
      });
      continue;
    }
    const provider = await factory({ env, ...input });
    if (!provider) {
      continue;
    }
    if (resolved) {
      logger.warn("capability_web_provider_conflict", {
        capabilityId: record.manifest.id,
        using: resolved.name,
      });
      continue;
    }
    resolved = provider;
  }
  return resolved;
}
