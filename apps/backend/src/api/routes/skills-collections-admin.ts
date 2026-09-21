import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  createSkillCollectionRequestSchema,
  setSkillCollectionItemsRequestSchema,
  updateSkillCollectionRequestSchema,
} from "@sourceweft/contracts";
import {
  createSkillCollection,
  deleteSkillCollection,
  listSkillCollectionsForAdmin,
  setSkillCollectionItems,
  updateSkillCollection,
} from "../../modules/skills/market/collections";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireSkillMarketAdmin } from "./skills-market-admin";

/**
 * The market admin's editorial collections: create, rename, reorder, publish,
 * delete, and set which skills are in one and in what order. The public reads
 * are in `skills-public.ts`.
 */

const BASE = "/v1/skills/registry/admin/collections";

async function body<Schema extends z.ZodTypeAny>(
  c: Context,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const raw = await c.req.json().catch(() => {
    throw ApiError.invalidJson();
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.flatten() as Record<string, unknown>,
    );
  }
  return parsed.data;
}

function collectionId(c: Context) {
  return decodeURIComponent(c.req.param("id") ?? "");
}

export function registerSkillCollectionAdminRoutes(app: Hono) {
  app.get(BASE, async (c) => {
    await requireSkillMarketAdmin(c);
    return ApiResponse.success(c, {
      items: await listSkillCollectionsForAdmin(),
    });
  });

  app.post(BASE, async (c) => {
    await requireSkillMarketAdmin(c);
    const input = await body(c, createSkillCollectionRequestSchema);
    return ApiResponse.success(c, await createSkillCollection(input), 201);
  });

  app.patch(`${BASE}/:id`, async (c) => {
    await requireSkillMarketAdmin(c);
    const input = await body(c, updateSkillCollectionRequestSchema);
    const updated = await updateSkillCollection(collectionId(c), input);
    if (!updated) throw ApiError.notFound("Collection not found");
    return ApiResponse.success(c, updated);
  });

  app.put(`${BASE}/:id/items`, async (c) => {
    await requireSkillMarketAdmin(c);
    const input = await body(c, setSkillCollectionItemsRequestSchema);
    const updated = await setSkillCollectionItems(collectionId(c), input.slugs);
    if (!updated) throw ApiError.notFound("Collection not found");
    return ApiResponse.success(c, updated);
  });

  app.delete(`${BASE}/:id`, async (c) => {
    await requireSkillMarketAdmin(c);
    if (!(await deleteSkillCollection(collectionId(c)))) {
      throw ApiError.notFound("Collection not found");
    }
    return ApiResponse.success(c, { deleted: true });
  });
}
