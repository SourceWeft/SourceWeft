import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  listMarketMcpRequestSchema,
  marketMcpManifestSchema,
} from "@sourceweft/market-contracts";
import { isMarketAdmin } from "../../modules/market/admin";
import { listMcpCategories } from "../../modules/market/read-categories";
import {
  findMcp,
  findMcpVersion,
  listMcp,
} from "../../modules/market/read-repository";
import {
  listReviewQueue,
  setSubmissionStatus,
} from "../../modules/market/review";
import {
  MarketSubmissionError,
  submitMcpFromGitHub,
} from "../../modules/market/submission";
import {
  getSessionUserId,
  requireSession,
} from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

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

  // --- Submission (any signed-in user) ---
  app.post("/v1/market/submissions", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const userId = getSessionUserId(session);
    const body = (await c.req.json().catch(() => null)) as {
      repoUrl?: unknown;
    } | null;
    const repoUrl = typeof body?.repoUrl === "string" ? body.repoUrl.trim() : "";
    if (!repoUrl) {
      throw ApiError.validation({ repoUrl: ["A GitHub repository URL is required"] });
    }
    try {
      const result = await submitMcpFromGitHub({ repoUrl, userId });
      return ApiResponse.success(c, result, 201);
    } catch (error) {
      if (error instanceof MarketSubmissionError) {
        throw new ApiError(422, error.code, error.message);
      }
      throw error;
    }
  });

  // --- Review (market admins only) ---
  async function requireMarketAdmin(c: Parameters<typeof requireSession>[0]) {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    if (!isMarketAdmin(getSessionUserId(session))) {
      throw ApiError.forbidden("Market admin access required");
    }
    return session;
  }

  app.get("/v1/market/admin/submissions", async (c) => {
    await requireMarketAdmin(c);
    return ApiResponse.success(c, { items: await listReviewQueue() });
  });

  app.post("/v1/market/admin/submissions/:identifier/publish", async (c) => {
    await requireMarketAdmin(c);
    const result = await setSubmissionStatus(
      decodeURIComponent(c.req.param("identifier")),
      "published",
    );
    if (!result) {
      throw ApiError.notFound("No submission awaiting review for that identifier");
    }
    return ApiResponse.success(c, result);
  });

  app.post("/v1/market/admin/submissions/:identifier/reject", async (c) => {
    await requireMarketAdmin(c);
    const result = await setSubmissionStatus(
      decodeURIComponent(c.req.param("identifier")),
      "archived",
    );
    if (!result) {
      throw ApiError.notFound("No submission awaiting review for that identifier");
    }
    return ApiResponse.success(c, result);
  });
}
