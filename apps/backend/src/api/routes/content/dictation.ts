import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  DICTATION_ERROR_CODES,
  DICTATION_LIMITS,
} from "@sourceweft/contracts/dictation";
import { billingRuntime as billingService } from "../../../billing-host/bindings";
import {
  isDictationAvailable,
  transcribeDictationSegment,
} from "../../../modules/dictation";
import { requireContentWorkspace } from "../../../modules/workspace/guards";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

const MAX_SEGMENT_BYTES = DICTATION_LIMITS.maxSegmentBytes;
// The segment plus a small allowance for the multipart envelope and fields.
const SEGMENT_BODY_LIMIT = MAX_SEGMENT_BYTES + 16 * 1024;

const segmentFieldsSchema = z.object({
  sessionId: z.string().uuid(),
  seq: z.coerce.number().int().min(0).max(100_000),
});

function invalidAudio(): ApiError {
  return new ApiError(
    400,
    DICTATION_ERROR_CODES.invalidAudio,
    "The recorded segment is not a valid audio file within the dictation limits.",
  );
}

export function registerDictationRoutes(app: Hono) {
  app.get("/dictation", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    await requireContentWorkspace({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, { available: await isDictationAvailable() });
  });

  app.post(
    "/dictation/segments",
    bodyLimit({
      maxSize: SEGMENT_BODY_LIMIT,
      onError: () => {
        throw invalidAudio();
      },
    }),
    async (c) => {
      const session = await requireSession(c);
      if (!session) {
        throw ApiError.unauthorized();
      }

      const form = await c.req.formData().catch(() => null);
      if (!form) {
        throw invalidAudio();
      }

      const file = form.get("file");
      if (!(file instanceof File) || file.size > MAX_SEGMENT_BYTES) {
        throw invalidAudio();
      }

      const parsed = segmentFieldsSchema.safeParse({
        sessionId: form.get("sessionId"),
        seq: form.get("seq"),
      });
      if (!parsed.success) {
        throw ApiError.validation(
          parsed.error.flatten() as Record<string, unknown>,
        );
      }

      const result = await transcribeDictationSegment(
        {
          workspaceId: requireRouteParam(c, "workspaceId"),
          userId: getSessionUserId(session),
          sessionId: parsed.data.sessionId,
          seq: parsed.data.seq,
          audio: new Uint8Array(await file.arrayBuffer()),
        },
        { billing: billingService },
      );

      if (result.kind === "limited") {
        c.header("Retry-After", String(result.retryAfterSeconds));
        throw new ApiError(
          429,
          DICTATION_ERROR_CODES.rateLimited,
          "You are sending dictation too quickly. Try again in a moment.",
          { retryAfterSeconds: result.retryAfterSeconds },
        );
      }

      return ApiResponse.success(c, {
        text: result.text,
        durationSec: result.durationSec,
      });
    },
  );
}
