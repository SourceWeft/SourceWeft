import type { Context } from "hono";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError } from "../../response/api-response";

/** The requester's UI language, for output when the sources are mixed. */
export function uiLocaleOf(c: Context) {
  const first = c.req.header("accept-language")?.split(",")[0]?.split(";")[0]?.trim();
  return first && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(first) ? first : "en";
}

/** The signed-in user's id; 401 without a session. */
export async function sessionUser(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  return getSessionUserId(session);
}
