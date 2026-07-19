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
