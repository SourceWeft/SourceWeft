import type { CapabilityHostEnvironment } from "@sourceweft/contracts/capability-host-services";
import type { SandboxProviderFactory } from "./runtime/types";

/**
 * The `sandbox_provider` host-service port.
 *
 * A capability that declares `sandbox_provider` in its manifest exports
 * `createSandboxProviderFactories` from its entry module; the host loads every
 * declaring capability, indexes the returned factories by `id`, and selects one
 * by the configured provider id. Nothing in the host names a provider.
 *
 * Why this port lives here and not in `@sourceweft/contracts/capability-host-
 * services` alongside `CreateHostWebProvider`: a sandbox provider factory
 * returns a `SandboxProvider`, whose interface is defined in this package, and
 * this package already depends on `@sourceweft/contracts`. Moving the whole
 * provider interface down into contracts to keep the two ports in one file
 * would drag the sandbox runtime's entire surface with it. This package is the
 * sandbox *ports* package — the host depends on it as infrastructure — so the
 * port is at home here, and the contracts file points at it.
 *
 * Configuration follows the same split as the web provider: everything
 * vendor-specific (API urls, keys, snapshot/image names) is read by the
 * capability from `env` under names it owns, and the only values the host
 * passes are the ones the host genuinely owns.
 */

/**
 * Host-owned, vendor-neutral limits every provider is built against.
 *
 * `maxOutputChars` is the deployment's cap on captured command output. It is
 * not a Daytona concept — every provider truncates against the same budget —
 * so the host keeps it and hands it over, exactly as it hands the web provider
 * its `fetchTimeoutMs`.
 */
export type SandboxProviderHostLimits = {
  readonly maxOutputChars: number;
};

export type CreateSandboxProviderFactoriesInput = {
  readonly env: CapabilityHostEnvironment;
  readonly limits: SandboxProviderHostLimits;
};

/**
 * Returns every provider this capability supplies. An array rather than a
 * single factory because one capability may front several related runtimes,
 * and because the host's collection is keyed by id either way.
 *
 * Returning an unconfigured factory is expected and correct: a factory reports
 * its own readiness through `getConfigurationStatus()`, and the host turns an
 * unconfigured selected provider into the same diagnosable startup warning it
 * always did. Returning nothing when a key is unset would instead make the
 * provider look uninstalled.
 */
export type CreateSandboxProviderFactories = (
  input: CreateSandboxProviderFactoriesInput,
) =>
  | readonly SandboxProviderFactory[]
  | Promise<readonly SandboxProviderFactory[]>;
