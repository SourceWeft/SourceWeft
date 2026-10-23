import type { RegistryInput, RegistryPackage } from "../types";

/**
 * Which package of a registry entry the sandboxed validation starts, and
 * how (Issue #367, W1b). Pure: the plan it builds is carried into the
 * sandbox and run there by `stdio-driver.mjs`; nothing here touches a
 * process or the network.
 *
 * Two package kinds run: npm through `npx`, PyPI through a throwaway venv
 * and `pip` (the sandbox image ships Node and Python 3.11, not `uv`; running
 * the console script named after the package is what `uvx <package>` does).
 * Container images (`oci`), NuGet and MCPB bundles are recorded as
 * unsupported: the sandbox runtime runs commands in its own image and cannot
 * start another image.
 *
 * The package is started as the registry describes it — runtime arguments,
 * the package, its arguments — with every input the registry marks required
 * filled with {@link MCP_STDIO_PLACEHOLDER}. No real credential ever reaches
 * the sandbox: a placeholder is enough for the server to answer `initialize`
 * and list its tools; a credential would only matter for calling one.
 */

export const MCP_STDIO_PLACEHOLDER = "placeholder";

/**
 * Wall clock for installing the package (a cold `npx` of a package with
 * native dependencies can take a minute), and for the server to start and
 * answer `initialize` and `tools/list` (the hard 60 s of the plan). The
 * driver enforces both inside the sandbox; the host's command timeout is
 * their sum plus a margin.
 */
export const MCP_STDIO_INSTALL_TIMEOUT_MS = 90_000;
export const MCP_STDIO_RUN_TIMEOUT_MS = 60_000;
/** CPU seconds either phase may burn (`ulimit -t`), a runaway build or loop. */
export const MCP_STDIO_CPU_SECONDS = 120;

/** Environment the server runs with, besides the registry's placeholders. */
export const MCP_STDIO_FIXED_ENV: Readonly<Record<string, string>> =
  Object.freeze({
    NO_COLOR: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_loglevel: "error",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONUNBUFFERED: "1",
  });

export type McpStdioRunnablePackage = {
  registryType: "npm" | "pypi";
  identifier: string;
  version: string | null;
};

/** The sandboxed start of one package, as `stdio-driver.mjs` reads it. */
export type McpStdioLaunchPlan = {
  package: McpStdioRunnablePackage;
  /** `sh -c` command that installs the package, run first, in the work dir. */
  install: string;
  /** `sh -c` command that starts the MCP server over stdio, in the work dir. */
  start: string;
  /** Placeholder values for the registry's required variables, plus fixed ones. */
  env: Record<string, string>;
  installTimeoutMs: number;
  runTimeoutMs: number;
  cpuSeconds: number;
};

export type McpStdioPackageChoice =
  | { kind: "plan"; plan: McpStdioLaunchPlan }
  | { kind: "unsupported"; detail: string };

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PYPI_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!+*-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAMED_ARGUMENT = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*=?$/;
const MAX_IDENTIFIER_CHARS = 214;
const MAX_VERSION_CHARS = 64;
const MAX_ARGUMENT_CHARS = 200;
const MAX_ARGUMENTS = 20;

/** POSIX single-quoting: safe for any string, including one with quotes. */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/**
 * The tokens an argument list contributes: a positional argument's literal
 * value, a required named argument followed by a placeholder, a required
 * positional without a value as a placeholder. Optional arguments without a
 * value are left out: the server must run without them.
 */
export function argumentTokens(input: RegistryInput[] | undefined): string[] {
  const tokens: string[] = [];
  for (const argument of (input ?? []).slice(0, MAX_ARGUMENTS)) {
    if (!isRecord(argument)) continue;
    const value = stringField(argument.value, MAX_ARGUMENT_CHARS);
    const name = stringField(argument.name, MAX_ARGUMENT_CHARS);
    if (argument.type === "named") {
      if (!name || !NAMED_ARGUMENT.test(name)) continue;
      if (value !== undefined) {
        tokens.push(...namedTokens(name, value));
      } else if (argument.isRequired === true) {
        tokens.push(...namedTokens(name, MCP_STDIO_PLACEHOLDER));
      }
      continue;
    }
    if (value !== undefined) {
      tokens.push(value);
    } else if (argument.isRequired === true) {
      tokens.push(MCP_STDIO_PLACEHOLDER);
    }
  }
  return tokens;
}

function namedTokens(name: string, value: string) {
  return name.endsWith("=") ? [`${name}${value}`] : [name, value];
}

/**
 * The environment the server is started with: a placeholder for each
 * variable the registry marks required (an optional variable left unset is
 * what a user who skipped it gets), on top of the fixed values. Only names a
 * shell accepts; never a value from the registry or from this process.
 */
export function placeholderEnvironment(
  variables: RegistryInput[] | undefined,
): Record<string, string> {
  const env: Record<string, string> = { ...MCP_STDIO_FIXED_ENV };
  for (const variable of variables ?? []) {
    if (!isRecord(variable) || variable.isRequired !== true) continue;
    const name = stringField(variable.name, 128);
    if (name && ENV_NAME.test(name) && !(name in MCP_STDIO_FIXED_ENV)) {
      env[name] = MCP_STDIO_PLACEHOLDER;
    }
  }
  return env;
}

function runnablePackage(
  entry: RegistryPackage,
): McpStdioRunnablePackage | undefined {
  const identifier = stringField(entry.identifier, MAX_IDENTIFIER_CHARS);
  const version = stringField(entry.version, MAX_VERSION_CHARS) ?? null;
  if (!identifier) return undefined;
  if (entry.registryType === "npm") {
    if (!NPM_NAME.test(identifier)) return undefined;
    if (version !== null && !NPM_VERSION.test(version)) return undefined;
    return { registryType: "npm", identifier, version };
  }
  if (entry.registryType === "pypi") {
    if (!PYPI_NAME.test(identifier)) return undefined;
    if (version !== null && !PYPI_VERSION.test(version)) return undefined;
    return { registryType: "pypi", identifier, version };
  }
  return undefined;
}

/** `name@version` for npm, `name==version` for PyPI; the name alone unpinned. */
export function packageSpec(pkg: McpStdioRunnablePackage) {
  if (pkg.version === null) return pkg.identifier;
  return pkg.registryType === "npm"
    ? `${pkg.identifier}@${pkg.version}`
    : `${pkg.identifier}==${pkg.version}`;
}

/** The commands for one runnable package, as the registry describes it. */
export function launchCommands(
  pkg: McpStdioRunnablePackage,
  entry: Pick<RegistryPackage, "runtimeArguments" | "packageArguments">,
): Pick<McpStdioLaunchPlan, "install" | "start"> {
  const spec = shellQuote(packageSpec(pkg));
  const runtime = argumentTokens(entry.runtimeArguments).map(shellQuote);
  const args = argumentTokens(entry.packageArguments).map(shellQuote);
  if (pkg.registryType === "npm") {
    // `--package` fills npx's cache without starting anything; the start
    // then finds the package there. `-y` is npx's own flag, so a registry
    // runtime argument of `-y` is dropped rather than passed twice.
    return {
      install: `npx --yes --package=${spec} -- true`,
      start: [
        "npx",
        "--yes",
        ...runtime.filter((t) => t !== "'-y'"),
        spec,
        ...args,
      ].join(" "),
    };
  }
  // The console script a PyPI package installs under its own name is what
  // `uvx <package>` runs; `uv` is not in the sandbox image, `pip` is.
  const script = shellQuote(`./venv/bin/${pkg.identifier}`);
  return {
    install: `python3 -m venv venv && ./venv/bin/pip install --quiet ${spec}`,
    start: [script, ...runtime, ...args].join(" "),
  };
}

/**
 * The first package the sandbox can run, as a launch plan — or why none can
 * be. Packages are taken in the registry's order; a package whose transport
 * is declared and is not stdio is passed over.
 */
export function chooseStdioPackage(packages: unknown): McpStdioPackageChoice {
  const entries = Array.isArray(packages) ? packages : [];
  const seen: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const pkg = entry as RegistryPackage;
    const transport = pkg.transport?.type;
    if (transport && transport !== "stdio") continue;
    const runnable = runnablePackage(pkg);
    if (!runnable) {
      seen.push(stringField(pkg.registryType, 64) ?? "unknown");
      continue;
    }
    return {
      kind: "plan",
      plan: {
        package: runnable,
        ...launchCommands(runnable, pkg),
        env: placeholderEnvironment(pkg.environmentVariables),
        installTimeoutMs: MCP_STDIO_INSTALL_TIMEOUT_MS,
        runTimeoutMs: MCP_STDIO_RUN_TIMEOUT_MS,
        cpuSeconds: MCP_STDIO_CPU_SECONDS,
      },
    };
  }
  return {
    kind: "unsupported",
    detail:
      seen.length > 0
        ? `No runnable npm or PyPI package; registry types: ${[...new Set(seen)].join(", ")}`
        : "No stdio package to run",
  };
}
