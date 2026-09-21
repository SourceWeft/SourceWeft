import type { Context, Hono } from "hono";
import {
  getMarketSkillResponseSchema,
  listMarketSkillCategoriesResponseSchema,
  listMarketSkillsRequestSchema,
  listMarketSkillsResponseSchema,
} from "@sourceweft/market-contracts";
import type { z } from "zod";
import {
  findMarketSkill,
  listMarketSkillCategories,
  listMarketSkills,
} from "../../modules/skills/market/read-repository";
import { ApiError } from "../response/api-response";
import { cachedJson } from "../response/cached-json";

/**
 * The public skill market: anonymous, cacheable reads of every skill that is
 * public and not built in. No session is read here at all, so a response can
 * never depend on who asked — which is what lets a shared cache hold it.
 */

const PUBLIC_MAX_AGE_SECONDS = 60;

/**
 * Path segments under `/v1/skills/` that are routes, not skills. `registry`
 * is the admin API's prefix: without this, `GET /v1/skills/registry` would be
 * looked up as a skill called "registry".
 */
export const RESERVED_MARKET_SKILL_SLUGS: ReadonlySet<string> = new Set([
  "categories",
  "category-counts",
  "registry",
]);

// Longer than any slug the registry derives; past it there is nothing to find.
const MAX_SLUG_LENGTH = 256;

/** A query parameter that was left empty was not given. */
function given(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * `true`/`false` (or `1`/`0`). Anything else is passed through as the string it
 * was, so the schema refuses it — reading a typo as `false` would quietly
 * answer a different question than the one asked.
 */
function booleanQuery(value: string | undefined): boolean | string | undefined {
  const raw = given(value)?.trim().toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return raw;
}

/** NaN for a limit that is not a number, which the schema refuses. */
function numberQuery(value: string | undefined): number | undefined {
  const raw = given(value);
  return raw === undefined ? undefined : Number(raw);
}

/**
 * Holds what goes out to the contract. A row the schema does not accept is our
 * data's fault, not the caller's, so it is a 500 and never a validation error.
 */
function conforming<Schema extends z.ZodTypeAny>(
  schema: Schema,
  body: unknown,
): z.infer<Schema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      500,
      "MARKET_SKILL_INVALID",
      "Stored skill does not conform to the public market schema",
    );
  }
  return parsed.data;
}

function publicJson(c: Context, body: unknown) {
  return cachedJson(c, body, { maxAge: PUBLIC_MAX_AGE_SECONDS });
}

export function registerSkillPublicRoutes(app: Hono) {
  app.get("/v1/skills", async (c) => {
    const parsed = listMarketSkillsRequestSchema.safeParse({
      query: given(c.req.query("query")),
      category: given(c.req.query("category")),
      verified: booleanQuery(c.req.query("verified")),
      capability: given(c.req.query("capability")),
      sort: given(c.req.query("sort")),
      limit: numberQuery(c.req.query("limit")),
      cursor: given(c.req.query("cursor")),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    return publicJson(
      c,
      conforming(
        listMarketSkillsResponseSchema,
        await listMarketSkills(parsed.data),
      ),
    );
  });

  // Registered before `/v1/skills/:slug` so the literal segment wins.
  app.get("/v1/skills/categories", async (c) =>
    publicJson(
      c,
      conforming(
        listMarketSkillCategoriesResponseSchema,
        await listMarketSkillCategories(),
      ),
    ),
  );

  app.get("/v1/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    // Not public, not there and not a skill at all are one answer: a 404 that
    // does not say which.
    const found =
      RESERVED_MARKET_SKILL_SLUGS.has(slug) || slug.length > MAX_SLUG_LENGTH
        ? null
        : await findMarketSkill(slug);
    if (!found) {
      throw ApiError.notFound("Skill not found");
    }
    return publicJson(c, conforming(getMarketSkillResponseSchema, found));
  });
}
