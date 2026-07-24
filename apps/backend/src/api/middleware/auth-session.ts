import type { Context } from "hono";
import { auth } from "../../modules/auth";

export type AppSession = {
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
  session: {
    id: string;
    userId: string;
    activeOrganizationId?: string | null;
  };
};

/**
 * One session lookup per request. Route handlers each call `requireSession`,
 * and middleware now does too; without this the workspace role guard would
 * double the session round-trips on every write.
 *
 * Keyed on the raw `Request`, which is unique per request and unreachable
 * afterwards, so entries cannot outlive the request they belong to.
 */
const sessionCache = new WeakMap<Request, AppSession | null>();

export async function requireSession(c: Context): Promise<AppSession | null> {
  const cached = sessionCache.get(c.req.raw);
  if (cached !== undefined) {
    return cached;
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const value = session ? (session as AppSession) : null;
  sessionCache.set(c.req.raw, value);

  return value;
}

export function getSessionUserId(session: AppSession) {
  return session.user.id;
}

export function getActiveOrganizationId(session: AppSession) {
  return session.session?.activeOrganizationId || null;
}
