import type { SandboxProvider } from "@sourceweft/builtin-tool-sandbox";
import type { McpStdioLaunchPlan } from "../../modules/market/validation/stdio-package";
import {
  MCP_STDIO_DRIVER_FILE,
  stdioDriverSource,
} from "../../modules/market/validation/stdio-driver-source";
import {
  parseStdioDriverResult,
  type McpStdioDriverResult,
} from "../../modules/market/validation/stdio-state";
import type { McpStdioSandboxReadiness } from "../../modules/market/validation/stdio-validate";
import {
  getSandboxProviderFactory,
  initializeSandboxProviderRegistry,
} from "../../modules/threads/agent/sandbox-service/provider-registry";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";

/**
 * One stdio validation in one sandbox (Issue #367, W1b). The market module
 * cannot reach the sandbox providers itself (it stays free of sibling
 * modules), so the worker lends it this: a fresh provider sandbox per
 * package, the driver and the plan uploaded into it, the driver run, its
 * result file read back, and the sandbox deleted whatever happened.
 *
 * The sandbox gets no credential and no platform secret: the plan's
 * environment is placeholders, and the driver itself allowlists what the
 * server inherits. Third-party code runs only there, never on this host.
 * Network: the providers offer no host allow-list that would fit a package
 * registry's CDN (Daytona's allow-list is CIDRs; Cloudflare's egress is
 * open), so the sandbox keeps the provider's default egress for the install.
 */

/**
 * How long the provider keeps the sandbox if this process dies before the
 * delete below: Daytona's auto-delete; long enough for the longest run.
 */
export const MCP_STDIO_SANDBOX_TTL_SECONDS = 10 * 60;
/** Driver start-up, the kill grace after a timeout, and the result write. */
const DRIVER_OVERHEAD_MS = 20_000;
/** The driver's own stdout: a one-line status; more means something odd. */
const DRIVER_OUTPUT_CHARS = 8_000;
/** The result file: 200 tools with schemas fit in a fraction of this. */
const RESULT_MAX_BYTES = 4 * 1024 * 1024;
const RESULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const WORK_DIRECTORY = "mcp-validate";

/** Whether this process can start a sandbox, and why not when it cannot. */
export async function mcpStdioSandboxReadiness(): Promise<McpStdioSandboxReadiness> {
  if (!config.sandbox.enabled) {
    return { ready: false, reason: "SOURCEWEFT_SANDBOX_ENABLED is not true" };
  }
  await initializeSandboxProviderRegistry();
  const factory = getSandboxProviderFactory(config.sandbox.provider);
  if (!factory) {
    return {
      ready: false,
      reason: `sandbox provider '${config.sandbox.provider}' is not installed`,
    };
  }
  const status = factory.getConfigurationStatus();
  if (!status.configured) {
    return {
      ready: false,
      reason: `sandbox provider '${factory.id}' is missing ${status.missing.join(", ")}`,
    };
  }
  return { ready: true };
}

function executeSystem(provider: SandboxProvider) {
  return provider.executeSystem
    ? provider.executeSystem.bind(provider)
    : provider.execute.bind(provider);
}

/**
 * Run `plan` in a fresh sandbox; the driver's result, or null when it left
 * none. Throws when the sandbox could not be created or used.
 */
export async function runMcpStdioValidationInSandbox(
  plan: McpStdioLaunchPlan,
  context: { identifier: string; version: string },
): Promise<McpStdioDriverResult | null> {
  await initializeSandboxProviderRegistry();
  const factory = getSandboxProviderFactory(config.sandbox.provider);
  if (!factory) {
    throw new Error(
      `sandbox provider '${config.sandbox.provider}' is not installed`,
    );
  }
  const provider = factory.createProvider();
  const startedAt = Date.now();
  const { id: providerSandboxId } = await provider.createSandbox({
    ttlSeconds: MCP_STDIO_SANDBOX_TTL_SECONDS,
    labels: {
      sourceweft: "true",
      provider: factory.id,
      purpose: "mcp-stdio-validation",
      environment: process.env.NODE_ENV || "development",
    },
  });
  const createdMs = Date.now() - startedAt;
  const directory = `${provider.pathPolicy.workspaceRoot}/${WORK_DIRECTORY}`;
  const log = {
    identifier: context.identifier,
    version: context.version,
    package: plan.package,
    provider: factory.id,
    providerSandboxId,
  };
  try {
    await provider.ensureDirectory({ providerSandboxId, directory });
    const encoder = new TextEncoder();
    await provider.uploadFile({
      providerSandboxId,
      sandboxPath: `${directory}/${MCP_STDIO_DRIVER_FILE}`,
      content: encoder.encode(stdioDriverSource()),
    });
    await provider.uploadFile({
      providerSandboxId,
      sandboxPath: `${directory}/plan.json`,
      content: encoder.encode(JSON.stringify(plan)),
    });
    const execution = await executeSystem(provider)({
      providerSandboxId,
      command: `node ${MCP_STDIO_DRIVER_FILE} plan.json result.json`,
      cwd: directory,
      timeoutMs: Math.min(
        plan.installTimeoutMs + plan.runTimeoutMs + DRIVER_OVERHEAD_MS,
        config.sandbox.maxCommandTimeoutMs,
      ),
      maxOutputChars: DRIVER_OUTPUT_CHARS,
    });
    logger.info("MCP stdio validation driver finished", {
      ...log,
      createdMs,
      exitCode: execution.exitCode,
      output: execution.output.trim().slice(0, 2000),
    });
    let text: string;
    try {
      const bytes = await provider.downloadFile({
        providerSandboxId,
        sandboxPath: `${directory}/result.json`,
        timeoutMs: RESULT_DOWNLOAD_TIMEOUT_MS,
      });
      if (bytes.byteLength > RESULT_MAX_BYTES) {
        logger.warn("MCP stdio validation result is too large", {
          ...log,
          bytes: bytes.byteLength,
        });
        return null;
      }
      text = bytes.toString("utf8");
    } catch (error) {
      logger.warn("MCP stdio validation left no result file", {
        ...log,
        exitCode: execution.exitCode,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const result = parseStdioDriverResult(text);
    if (!result) {
      logger.warn("MCP stdio validation result is not the driver's", {
        ...log,
        text: text.slice(0, 500),
      });
    }
    return result;
  } finally {
    try {
      await provider.deleteSandbox(providerSandboxId);
    } catch (error) {
      // The provider's TTL reaps it; say so where an operator can see.
      logger.warn("MCP stdio validation sandbox could not be deleted", {
        ...log,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
