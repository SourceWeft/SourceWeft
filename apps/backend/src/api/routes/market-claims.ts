import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  setMcpOwnerOverridesRequestSchema,
  startMcpClaimRequestSchema,
} from "@sourceweft/contracts";
import { submitMarketMcpOwnerToolsRequestSchema } from "@sourceweft/market-contracts";
import { isMarketAdmin } from "../../modules/market/admin";
import {
  adminRevokeMcpClaim,
  adminUnblockMcpClaim,
  clearMcpOwnerTools,
  getMcpClaimOverview,
  getMcpOwnerOverrides,
  listMcpClaimsForAdmin,
  revokeMcpClaim,
  setMcpOwnerOverrides,
  setMcpOwnerTools,
  startMcpClaim,
  verifyMcpClaim,
} from "../../modules/market/claims/service";
import { logger } from "../../shared/logger";
import { requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";

/**
 * Owner claims and corrections for catalog MCP servers (Issue #367, W7;
 * `modules/market/claims`). A claim belongs to the signed-in member, not a
 * workspace, so nothing here is workspace-scoped. The session may come from
 * a cookie or from a user API key (`x-api-key`), which is how
 * `sourceweft mcp submit-tools` signs its request.
 *
 * Identifiers contain a slash (`com.notion/mcp`) and arrive percent-encoded
 * as one path segment; Hono hands them back decoded.
 */

async function requireUserId(c: Context): Promise<string> {
  const session = await requireSession(c);
  // An organization API key resolves to a session without a user: a claim is
  // a person's, so that is not signed in here.
  const userId = session?.user?.id;
  if (!userId) throw ApiError.unauthorized();
  return userId;
}

// Corrections are a few short fields; a tool list is at most 200 tools of
// 32 KiB each plus the server's self-description.
const OVERRIDES_BODY_LIMIT = 64 * 1024;
const TOOLS_BODY_LIMIT = 8 * 1024 * 1024;

function limitBody(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    },
  });
}

async function requireMarketAdminId(c: Context): Promise<string> {
  const userId = await requireUserId(c);
  if (!isMarketAdmin(userId)) {
    throw ApiError.forbidden("Market admin access required");
  }
  return userId;
}

async function parseBody<T>(
  c: Context,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } },
): Promise<T> {
  const raw = await c.req.json().catch(() => {
    throw ApiError.invalidJson();
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
  }
  return parsed.data;
}

export function registerMarketClaimRoutes(app: Hono) {
  // Where this entry stands for the signed-in member: whether it is claimed,
  // their own claims, which methods apply, and their corrections if they are
  // a verified owner.
  app.get("/v1/market/mcp/:identifier/claim", async (c) => {
    const userId = await requireUserId(c);
    return ApiResponse.success(
      c,
      await getMcpClaimOverview({ userId, identifier: c.req.param("identifier") }),
    );
  });

  app.post("/v1/market/mcp/:identifier/claims", async (c) => {
    const userId = await requireUserId(c);
    const body = await parseBody(c, startMcpClaimRequestSchema);
    const identifier = c.req.param("identifier");
    const result = await startMcpClaim({ userId, identifier, ...body });
    logger.info("MCP catalog claim started", {
      userId,
      identifier,
      claimId: result.claim.id,
      method: result.claim.method,
      status: result.claim.status,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.post("/v1/market/mcp-claims/:claimId/verify", async (c) => {
    const userId = await requireUserId(c);
    const result = await verifyMcpClaim({ userId, claimId: c.req.param("claimId") });
    logger.info("MCP catalog claim verified", {
      userId,
      claimId: result.claim.id,
      identifier: result.claim.identifier,
      method: result.claim.method,
    });
    return ApiResponse.success(c, result);
  });

  app.post("/v1/market/mcp-claims/:claimId/revoke", async (c) => {
    const userId = await requireUserId(c);
    const result = await revokeMcpClaim({ userId, claimId: c.req.param("claimId") });
    logger.info("MCP catalog claim given up", {
      userId,
      claimId: result.claim.id,
      identifier: result.claim.identifier,
    });
    return ApiResponse.success(c, result);
  });

  // --- Corrections (verified owners only) ---

  app.get("/v1/market/mcp/:identifier/owner-overrides", async (c) => {
    const userId = await requireUserId(c);
    return ApiResponse.success(
      c,
      await getMcpOwnerOverrides({ userId, identifier: c.req.param("identifier") }),
    );
  });

  app.put("/v1/market/mcp/:identifier/owner-overrides", limitBody(OVERRIDES_BODY_LIMIT), async (c) => {
    const userId = await requireUserId(c);
    const values = await parseBody(c, setMcpOwnerOverridesRequestSchema);
    const identifier = c.req.param("identifier");
    const result = await setMcpOwnerOverrides({ userId, identifier, values });
    logger.info("MCP catalog listing corrected by its owner", {
      userId,
      identifier,
      fields: Object.keys(result.values),
    });
    return ApiResponse.success(c, result);
  });

  // The tool list the owner generated on their own machine
  // (`sourceweft mcp inspect`), uploaded by `sourceweft mcp submit-tools`.
  app.put("/v1/market/mcp/:identifier/owner-overrides/tools", limitBody(TOOLS_BODY_LIMIT), async (c) => {
    const userId = await requireUserId(c);
    const submission = await parseBody(c, submitMarketMcpOwnerToolsRequestSchema);
    const identifier = c.req.param("identifier");
    const result = await setMcpOwnerTools({ userId, identifier, submission });
    logger.info("MCP catalog tool list submitted by its owner", {
      userId,
      identifier,
      tools: result.tools?.count ?? 0,
    });
    return ApiResponse.success(c, result);
  });

  app.delete("/v1/market/mcp/:identifier/owner-overrides/tools", async (c) => {
    const userId = await requireUserId(c);
    const identifier = c.req.param("identifier");
    const result = await clearMcpOwnerTools({ userId, identifier });
    logger.info("MCP catalog owner tool list removed", { userId, identifier });
    return ApiResponse.success(c, result);
  });

  // --- Market admins ---

  app.get("/v1/market/admin/mcp/claims", async (c) => {
    await requireMarketAdminId(c);
    const identifier = c.req.query("identifier")?.trim() || null;
    return ApiResponse.success(c, {
      items: await listMcpClaimsForAdmin({ identifier }),
    });
  });

  app.post("/v1/market/admin/mcp/claims/:claimId/revoke", async (c) => {
    const adminUserId = await requireMarketAdminId(c);
    const result = await adminRevokeMcpClaim({
      adminUserId,
      claimId: c.req.param("claimId"),
    });
    logger.info("MCP catalog claim revoked by a market admin", {
      adminUserId,
      claimId: result.claim.id,
      identifier: result.claim.identifier,
    });
    return ApiResponse.success(c, result);
  });

  app.post("/v1/market/admin/mcp/claims/:claimId/unblock", async (c) => {
    const adminUserId = await requireMarketAdminId(c);
    const result = await adminUnblockMcpClaim({ claimId: c.req.param("claimId") });
    logger.info("MCP catalog claim block lifted by a market admin", {
      adminUserId,
      claimId: result.claim.id,
      identifier: result.claim.identifier,
    });
    return ApiResponse.success(c, result);
  });
}
