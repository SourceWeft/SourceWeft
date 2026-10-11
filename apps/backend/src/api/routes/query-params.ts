import type { z } from "zod";
import { ApiError } from "../response/api-response";

/**
 * A `?locale=` query parameter read against the catalog's locale schema. An
 * absent, empty or blank parameter was not given (the caller picks its
 * default); any other value outside the schema is a 400, never a silent
 * default.
 */
export function parseLocaleQuery<TSchema extends z.ZodType<string>>(
  schema: TSchema,
  raw: string | undefined,
): z.output<TSchema> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.flatten() as Record<string, unknown>,
    );
  }
  return parsed.data;
}
