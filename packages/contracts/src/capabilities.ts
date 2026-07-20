import { z } from "zod";

/**
 * Shared vocabulary for capability/tool options. Kept in its own module so both
 * the stream-request schemas and the skill-manifest schemas can depend on it
 * without importing each other.
 */
export const capabilityOptionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

/**
 * An option's declaration that its offered values are narrowed by the selected
 * model. See `AgentToolModelCatalogValues` in `agent-tools/model-catalog.ts`
 * for the reasoning and `filterModelSupportedOptionValues` for the resolver
 * every client uses; this is the wire form of the same pointer, carried on the
 * option through the capability catalog and the skill manifest.
 */
export const capabilityOptionModelValuesSchema = z
  .object({
    key: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
