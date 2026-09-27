import "dotenv/config";
import { randomUUID } from "node:crypto";
import { closeDatabase } from "@sourceweft/db";
import {
  createOverviewModelCall,
  resolveOverviewModelConfigurationKey,
} from "../modules/catalog-overview/model";
import {
  generateMcpOverview,
  loadMcpOverviewSubject,
  mcpOverviewAdapter,
  mcpOverviewSkipReason,
} from "../modules/market/overview/generate";
import { McpOverviewOutputError } from "../modules/market/overview/prompt";
import type { McpOverviewPrompt } from "../modules/market/overview/prompt";
import {
  findMcpServerOverviewTarget,
  listMcpOverviewRows,
  mcpOverviewRepository,
} from "../modules/market/overview/repository";
import { getSystemModelReadiness } from "../shared/model-gateway/system-client";

/**
 * Manual smoke test of MCP AI overviews: one real generation for one server
 * through the catalog overview engine and the system model, against the
 * catalog in DATABASE_URL and the SYSTEM_MODEL_* settings. Prints the
 * readiness, what the overview was written from, the three locales and the
 * classification. The key is never printed; the `system_model.call` line is
 * logged as for any call.
 *
 * By default the overview is generated as the worker would with a forced
 * request, so it is PUBLISHED: the rows replace the server's current
 * overview (hidden stays hidden) and its categories become `ai` unless an
 * admin chose them. `--dry-run` asks the model and checks the answer the
 * same way but writes nothing.
 *
 *   SYSTEM_MODEL_ENABLED=true SYSTEM_MODEL_PROVIDER=openrouter \
 *   SYSTEM_MODEL_NAME=deepseek/deepseek-v4.1-flash SYSTEM_MODEL_API_KEY=... \
 *   pnpm --filter @sourceweft/backend exec tsx src/scripts/smoke-mcp-overview.ts \
 *     io.github.FTHTrading/genesis402-mcp [--dry-run]
 */

function usage(): never {
  console.error(
    "Usage: tsx src/scripts/smoke-mcp-overview.ts <mcp-identifier> [--dry-run]",
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const identifier = args.find((arg) => !arg.startsWith("--"));
  if (!identifier) usage();

  const readiness = await getSystemModelReadiness();
  console.log("System model readiness", {
    enabled: readiness.enabled,
    configured: readiness.configured,
    ready: readiness.ready,
    provider: readiness.provider,
    model: readiness.model,
    reason: readiness.reason,
  });
  if (!readiness.ready) {
    process.exitCode = 1;
    return;
  }

  const target = await findMcpServerOverviewTarget(identifier);
  if (!target?.versionId) {
    console.error(
      target
        ? `${identifier} has no published version`
        : `No MCP server ${identifier} in the catalog`,
    );
    process.exitCode = 1;
    return;
  }
  const subject = await loadMcpOverviewSubject(target.versionId);
  if (!subject) throw new Error("The version disappeared");
  const skip = mcpOverviewSkipReason(subject);
  console.log("Subject", {
    identifier: subject.identifier,
    version: subject.version,
    versionId: subject.versionId,
    eligible: subject.eligible,
    readmeStatus: subject.readmeStatus,
    readmeInPrompt: Boolean(subject.input?.readme?.segments.length),
    readmeTruncated: subject.input?.readme?.truncated ?? false,
    envVars: subject.input?.facts.envVars.map((variable) => variable.name),
    headers: subject.input?.facts.headers.map((variable) => variable.name),
    packages: subject.input?.facts.packages.map((pkg) => pkg.identifier),
    inputSha256: subject.input?.inputSha256 ?? null,
    skipReason: skip,
    categoriesSource: target.categoriesSource,
  });
  if (skip) {
    console.error(`No overview is written for it now: ${skip}`);
    process.exitCode = 1;
    return;
  }

  const scopeId = `smoke-mcp-overview:${randomUUID()}`;
  if (dryRun) {
    const prompt = mcpOverviewAdapter.buildPrompt(subject);
    const call = createOverviewModelCall<McpOverviewPrompt>(mcpOverviewAdapter);
    const { output, model } = await call({
      prompt,
      versionId: subject.versionId,
      scopeId,
    });
    const parsed = mcpOverviewAdapter.parseOutput(output, subject, prompt);
    console.log("Model", model);
    for (const [locale, overview] of Object.entries(parsed.overviews)) {
      console.log(`--- ${locale} ---\n${JSON.stringify(overview, null, 2)}`);
    }
    console.log(
      `--- classification ---\n${JSON.stringify(parsed.classification, null, 2)}`,
    );
    console.log("Dry run: nothing was written.");
    return;
  }

  const result = await generateMcpOverview({
    versionId: subject.versionId,
    scopeId,
    force: true,
    modelConfigurationKey:
      (await resolveOverviewModelConfigurationKey()) ?? undefined,
  });
  console.log("Result", result);
  if (result.status !== "generated" && result.status !== "copied") {
    process.exitCode = 1;
    return;
  }
  for (const row of await listMcpOverviewRows(subject.versionId)) {
    console.log(
      `--- ${row.locale} (${row.model}${row.hidden ? ", hidden" : ""}) ---\n${JSON.stringify(row.overview, null, 2)}`,
    );
  }
  const analysis = await mcpOverviewRepository.read(subject.versionId);
  console.log(
    `--- classification (${analysis?.status}) ---\n${JSON.stringify(analysis?.classification ?? null, null, 2)}`,
  );
}

main()
  .catch((error: unknown) => {
    if (error instanceof McpOverviewOutputError) {
      // Our own check of the answer: the reason names the rule, not content.
      console.error(
        `MCP overview smoke failed: the answer was refused (${error.reason}): ${error.message}`,
      );
    } else {
      // Provider errors can echo request details; print the class and code only.
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      const message =
        error instanceof Error && error.name === "SystemModelUnavailableError"
          ? error.message
          : `${error instanceof Error ? error.name : "Error"}${code ? ` (${code})` : ""}`;
      console.error(`MCP overview smoke failed: ${message}`);
    }
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
