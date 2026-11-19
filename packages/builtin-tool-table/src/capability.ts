import type { CreateTableCapability } from "@sourceweft/contracts/table-capability";
import { MAX_TOTAL_INPUT_TOKENS } from "@sourceweft/grounded-generation";
import { TABLE_JOB_TIMEOUT_MS } from "./engine/constants";
import { fillTable } from "./engine/fill";
import { planFill, resolveColumns } from "./engine/plan";
import { suggestColumns } from "./engine/suggest";

/**
 * Server-only: the engine imports `node:crypto` through the shared grounding
 * helpers. The host reaches it through the registry's server entry, never from
 * a browser graph (the web imports `./ui` and `./export` only).
 */
export const createTableCapability: CreateTableCapability = () => ({
  generation: {
    suggestColumns,
    resolveColumns,
    planFill,
    fillTable,
    limits: {
      maxTotalInputTokens: MAX_TOTAL_INPUT_TOKENS,
      jobTimeoutMs: TABLE_JOB_TIMEOUT_MS,
    },
  },
});
