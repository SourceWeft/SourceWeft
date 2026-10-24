import { z } from "zod";
import type {
  MarketMcpInspectFile,
  MarketMcpInspectedTool,
  SubmitMarketMcpOwnerToolsRequest,
} from "@sourceweft/market-contracts";

/**
 * The inspect file and the submit request, as the CLI reads and writes them.
 *
 * `@sourceweft/market-contracts` is the platform's contract for both, but the
 * CLI imports only its TYPES: the package is not built where the CLI is
 * tested and published from, and a published CLI should not validate against
 * everything the website's contract grows. These schemas hold what the file
 * and the request carry today.
 *
 * Two guards keep them from drifting from the platform:
 * - the type assertions at the bottom fail `check-types` when either side's
 *   shape changes;
 * - `test/mcp-contract.test.ts` compares the limits with the contract's
 *   source.
 */

export const MARKET_MCP_INSPECT_LIMITS = Object.freeze({
  tools: 200,
  nameChars: 128,
  titleChars: 200,
  descriptionChars: 2_000,
  schemaBytes: 16 * 1024,
  toolBytes: 32 * 1024,
  serverInfoBytes: 4 * 1024,
});

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
}

export const inspectedToolSchema = z
  .object({
    name: z.string().min(1).max(MARKET_MCP_INSPECT_LIMITS.nameChars),
    title: z.string().max(MARKET_MCP_INSPECT_LIMITS.titleChars).optional(),
    description: z
      .string()
      .max(MARKET_MCP_INSPECT_LIMITS.descriptionChars)
      .optional(),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (tool) =>
      jsonBytes(tool.inputSchema) +
        jsonBytes(tool.outputSchema) +
        jsonBytes(tool.annotations) <=
      MARKET_MCP_INSPECT_LIMITS.toolBytes,
    {
      message: `A tool's schemas and annotations may take at most ${MARKET_MCP_INSPECT_LIMITS.toolBytes} bytes together`,
    },
  );

const serverInfoSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => jsonBytes(value) <= MARKET_MCP_INSPECT_LIMITS.serverInfoBytes,
    {
      message: `serverInfo may take at most ${MARKET_MCP_INSPECT_LIMITS.serverInfoBytes} bytes`,
    },
  );

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url() }),
  z.object({ kind: z.literal("stdio"), command: z.string().min(1) }),
]);

export const inspectFileSchema = z.object({
  schemaVersion: z.literal(1),
  generatedBy: z.string(),
  generatedAt: z.string(),
  target: targetSchema,
  protocolVersion: z.string().optional(),
  serverInfo: serverInfoSchema.optional(),
  tools: z.array(inspectedToolSchema).max(MARKET_MCP_INSPECT_LIMITS.tools),
});

/** What `submit-tools` sends: never the file's `target`. */
export const submitToolsRequestSchema = z
  .object({
    tools: z.array(inspectedToolSchema).max(MARKET_MCP_INSPECT_LIMITS.tools),
    generatedAt: z.string().optional(),
    serverInfo: serverInfoSchema.optional(),
  })
  .strict();

// --- Type-level drift guards ------------------------------------------------
// Each side must be assignable to the other; a changed field on either breaks
// `check-types` here instead of failing a submission at runtime.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameFile: Equal<
  z.output<typeof inspectFileSchema>,
  MarketMcpInspectFile
> = true;
const sameTool: Equal<
  z.output<typeof inspectedToolSchema>,
  MarketMcpInspectedTool
> = true;
const sameRequest: Equal<
  z.output<typeof submitToolsRequestSchema>,
  SubmitMarketMcpOwnerToolsRequest
> = true;
export const CONTRACT_GUARDS = [sameFile, sameTool, sameRequest] as const;
