import type { AgentToolWebProvider } from "./agent-tools/host";
import type { AgentToolDefinitionShape } from "./agent-tools/define";
import type { ConnectorAdapter } from "./connectors";

/**
 * Host-service extension points a capability package fills.
 *
 * Some capabilities do not only contribute tools an agent calls in a turn —
 * they supply an implementation the *host* itself runs on: the adapter behind a
 * connector's OAuth and sync, or the provider behind web search and fetch. Both
 * used to be constructed by name in `apps/backend/src`, which made the host's
 * build depend on which capabilities happened to be installed.
 *
 * These factories are the manifest-driven replacement, and they mirror
 * `createCapabilityAgentTools` and `createDeliverablePipelines`: a capability
 * declares the service in its manifest, exports the matching factory from its
 * entry module, and the host discovers the module through the manifest and
 * calls whatever factory it finds. The host names no capability.
 *
 * Configuration is deliberately not passed in as a typed bag. Every key a
 * connector's OAuth client needs is capability-specific — `NOTION_CLIENT_ID`
 * means nothing to the host — so the host lends a narrow environment reader and
 * the capability reads the names it owns. The one genuinely host-owned value,
 * the deployment's public base URL, is passed explicitly.
 */
export type CapabilityHostEnvironment = {
  /** The deployment's public base URL, e.g. for OAuth redirect construction. */
  readonly baseUrl: string;
  /** Read a process environment variable by a capability-owned name. */
  get(name: string): string | undefined;
};

/**
 * What a connector capability hands the host: the adapter(s) the connector
 * registry drives, and the agent tool definitions that expose the connector's
 * actions to a turn. Returned together because they are two halves of one
 * contribution and registering one without the other yields a connector that
 * either syncs but cannot be called, or vice versa.
 */
export type CapabilityConnectorContribution = {
  readonly adapters: readonly ConnectorAdapter[];
  readonly agentToolDefs: readonly AgentToolDefinitionShape[];
};

export type CreateConnectorAdapters = (input: {
  readonly env: CapabilityHostEnvironment;
}) =>
  | CapabilityConnectorContribution
  | Promise<CapabilityConnectorContribution>;

/**
 * Builds the host's web provider, or null when the capability is not configured
 * (no API key). Returning null is not an error: the host treats "no provider"
 * as "web tools unavailable", exactly as it did when the key was unset.
 */
export type CreateHostWebProviderInput = {
  readonly env: CapabilityHostEnvironment;
  /**
   * Per-call-site fetch budget. Vendor-neutral and genuinely the host's to
   * decide: ingesting a source document tolerates a far longer fetch than a
   * tool call inside a live turn. Providers that cannot honour it may ignore
   * it.
   */
  readonly fetchTimeoutMs?: number;
};

export type CreateHostWebProvider = (input: CreateHostWebProviderInput) =>
  | AgentToolWebProvider
  | null
  | Promise<AgentToolWebProvider | null>;

/**
 * The shape of a capability entry module as far as host services are
 * concerned. Every member is optional: the host probes for the factory it
 * needs and skips modules that do not export it.
 *
 * Not every host-service port can live in this file. `sandbox_provider`'s
 * factory returns a `SandboxProvider`, an interface owned by
 * `@sourceweft/builtin-tool-sandbox` — which already depends on this package,
 * so declaring the port here would invert that dependency. It is declared as
 * `CreateSandboxProviderFactories` there instead, and the host narrows the
 * module to it directly. The rule is the same either way: the port is a shared
 * shape, and the capability that fills it is never named by the host.
 */
export type CapabilityHostServiceModule = {
  readonly createConnectorAdapters?: CreateConnectorAdapters;
  readonly createHostWebProvider?: CreateHostWebProvider;
};
