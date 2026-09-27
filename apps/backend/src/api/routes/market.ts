import type { Hono } from "hono";
import {
  listMarketMcpRequestSchema,
  marketMcpLocaleSchema,
  marketMcpManifestSchema,
} from "@sourceweft/market-contracts";
import {
  getMcpOverviewAdminResponseSchema,
  mcpOverviewStatusResponseSchema,
  regenerateMcpOverviewResponseSchema,
  setMcpOverviewHiddenRequestSchema,
  setMcpOverviewHiddenResponseSchema,
} from "@sourceweft/contracts";
import { isMarketAdmin } from "../../modules/market/admin";
import {
  findMcpOverviewAdminState,
  getMcpOverviewStatus,
  regenerateMcpOverview,
  setMcpOverviewHidden,
} from "../../modules/market/overview/admin";
import { listMcpCategories } from "../../modules/market/read-categories";
import {
  countMcpByCategory,
  findMcp,
  findMcpVersion,
  listMcp,
} from "../../modules/market/read-repository";
import {
  readMcpReadmeAdminStatus,
  requestMcpReadmeRefetch,
} from "../../modules/market/readme/readme-admin";
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
import { cachedJson } from "../response/cached-json";

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
      desktopOnly: booleanQuery(c.req.query("desktopOnly")),
      limit: numberQuery(c.req.query("limit")),
      cursor: c.req.query("cursor"),
      locale: c.req.query("locale") || undefined,
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

  // Registered before `/v1/mcp/:identifier` so the literal segment wins.
  app.get("/v1/mcp/category-counts", async (c) =>
    cachedJson(
      c,
      await countMcpByCategory({
        query: c.req.query("query"),
        includeDesktopOnly: booleanQuery(c.req.query("includeDesktopOnly")),
        desktopOnly: booleanQuery(c.req.query("desktopOnly")),
      }),
      { maxAge: 60 },
    ),
  );

  app.get("/v1/mcp/:identifier", async (c) => {
    // The language of the AI overview; English when not given.
    const locale = marketMcpLocaleSchema
      .optional()
      .safeParse(c.req.query("locale") || undefined);
    if (!locale.success) {
      throw ApiError.validation(
        locale.error.flatten() as Record<string, unknown>,
      );
    }
    const record = await findMcp(
      decodeURIComponent(c.req.param("identifier")),
      { locale: locale.data },
    );
    if (!record) {
      throw ApiError.notFound("MCP item not found");
    }
    return cachedJson(
      c,
      {
        item: record.item,
        versions: record.versions,
        readme: record.readme,
        aiOverview: record.aiOverview,
      },
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

  // README fetch state of the catalog, and whether the worker's GitHub reads
  // carry a token.
  app.get("/v1/market/admin/mcp/readme/status", async (c) => {
    await requireMarketAdmin(c);
    return ApiResponse.success(c, await readMcpReadmeAdminStatus());
  });

  // Fetch one server's README again now: back to `pending`, due now, no
  // attempts counted, and a fetch job queued for it.
  app.post("/v1/market/admin/mcp/:identifier/readme/refetch", async (c) => {
    await requireMarketAdmin(c);
    const result = await requestMcpReadmeRefetch(
      decodeURIComponent(c.req.param("identifier")),
    );
    if (!result) {
      throw ApiError.notFound(
        "No published public MCP server with that identifier",
      );
    }
    return ApiResponse.success(c, result, 202);
  });

  // --- AI overviews (market admins only) ---

  // Whether the system model can write overviews, and how far they have got.
  app.get("/v1/market/admin/mcp/overview/status", async (c) => {
    await requireMarketAdmin(c);
    return ApiResponse.success(
      c,
      mcpOverviewStatusResponseSchema.parse(await getMcpOverviewStatus()),
    );
  });

  // One server's overview in every language (hidden ones included) and its
  // generation state.
  app.get("/v1/market/admin/mcp/:identifier/overview", async (c) => {
    await requireMarketAdmin(c);
    const state = await findMcpOverviewAdminState(
      decodeURIComponent(c.req.param("identifier")),
    );
    if (!state) {
      throw ApiError.notFound("No MCP server with that identifier");
    }
    return ApiResponse.success(
      c,
      getMcpOverviewAdminResponseSchema.parse({
        ...state,
        analysis: state.analysis
          ? {
              ...state.analysis,
              updatedAt: state.analysis.updatedAt.toISOString(),
            }
          : null,
        overviews: state.overviews.map((entry) => ({
          ...entry,
          generatedAt: entry.generatedAt.toISOString(),
        })),
      }),
    );
  });

  // Write the latest version's overview again, even for unchanged input. The
  // current one stays live until the new one is published.
  app.post(
    "/v1/market/admin/mcp/:identifier/overview/regenerate",
    async (c) => {
      const session = await requireMarketAdmin(c);
      const result = await regenerateMcpOverview({
        identifier: decodeURIComponent(c.req.param("identifier")),
        actorUserId: getSessionUserId(session),
      });
      if (!result) {
        throw ApiError.notFound(
          "No MCP server with a published version for that identifier",
        );
      }
      return ApiResponse.success(
        c,
        regenerateMcpOverviewResponseSchema.parse(result),
        result.queued ? 202 : 200,
      );
    },
  );

  // Hide or show the latest version's overview in every language. The page
  // falls back to the author's description; a hidden overview stays hidden
  // when it is regenerated.
  app.post("/v1/market/admin/mcp/:identifier/overview/hidden", async (c) => {
    const session = await requireMarketAdmin(c);
    const body = await c.req.json().catch(() => {
      throw ApiError.invalidJson();
    });
    const parsed = setMcpOverviewHiddenRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const result = await setMcpOverviewHidden({
      identifier: decodeURIComponent(c.req.param("identifier")),
      hidden: parsed.data.hidden,
      actorUserId: getSessionUserId(session),
    });
    if (!result) {
      throw ApiError.notFound(
        "This MCP server's latest version has no overview",
      );
    }
    return ApiResponse.success(
      c,
      setMcpOverviewHiddenResponseSchema.parse(result),
    );
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
