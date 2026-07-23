import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  listMarketMcpRequestSchema,
  marketMcpManifestSchema,
} from "@sourceweft/market-contracts";
import { listMcpCategories } from "../../modules/market/read-categories";
import {
  findMcp,
  findMcpVersion,
  listMcp,
} from "../../modules/market/read-repository";
import { ApiError } from "../response/api-response";

function booleanQuery(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value === "true" || value === "1";
}

function numberQuery(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * JSON response with a content-hash ETag + Cache-Control that honors
 * If-None-Match (304). Catalog reads are safe to revalidate cheaply; a manifest
 * is immutable per identifier@version so it can be cached hard.
 */
function cachedJson(
  c: Context,
  body: unknown,
  options: { maxAge?: number; immutable?: boolean } = {},
) {
  const payload = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(payload).digest("hex").slice(0, 32)}"`;
  const maxAge = options.maxAge ?? 60;
  c.header("etag", etag);
  c.header(
    "cache-control",
    options.immutable
      ? `public, max-age=${maxAge}, immutable`
      : `public, max-age=${maxAge}`,
  );
  if (c.req.header("if-none-match") === etag) {
    return c.body(null, 304);
  }
  c.header("content-type", "application/json; charset=UTF-8");
  return c.body(payload, 200);
}

export function registerMarketRoutes(app: Hono) {
  app.get("/v1/mcp", async (c) => {
    const parsed = listMarketMcpRequestSchema.safeParse({
      query: c.req.query("query"),
      category: c.req.query("category"),
      transport: c.req.query("transport"),
      official: booleanQuery(c.req.query("official")),
      verified: booleanQuery(c.req.query("verified")),
      runtime: c.req.query("runtime"),
      includeDesktopOnly: booleanQuery(c.req.query("includeDesktopOnly")),
      limit: numberQuery(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    return cachedJson(c, await listMcp(parsed.data), { maxAge: 60 });
  });

  app.get("/v1/mcp/categories", async (c) =>
    cachedJson(c, await listMcpCategories(), { maxAge: 300 }),
  );

  app.get("/v1/mcp/:identifier", async (c) => {
    const record = await findMcp(decodeURIComponent(c.req.param("identifier")));
    if (!record) {
      throw ApiError.notFound("MCP item not found");
    }
    return cachedJson(
      c,
      { item: record.item, versions: record.versions },
      { maxAge: 60 },
    );
  });

  app.get("/v1/mcp/:identifier/manifest", async (c) => {
    const found = await findMcpVersion(
      decodeURIComponent(c.req.param("identifier")),
      c.req.query("version"),
    );
    if (!found) {
      throw ApiError.notFound("MCP manifest not found");
    }
    // Enforce the manifest contract on the wire so stored drift surfaces here.
    const manifest = marketMcpManifestSchema.safeParse(
      found.itemVersion.manifestJson,
    );
    if (!manifest.success) {
      throw new ApiError(
        500,
        "MANIFEST_INVALID",
        "Stored MCP manifest does not conform to the manifest schema",
      );
    }
    return cachedJson(
      c,
      {
        item: found.record.item,
        version: found.itemVersion,
        manifest: manifest.data,
        signature: null,
        signingKeyId: null,
      },
      { maxAge: 3600, immutable: true },
    );
  });
}
