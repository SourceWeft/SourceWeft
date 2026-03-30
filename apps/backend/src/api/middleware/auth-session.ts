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

export async function requireSession(c: Context): Promise<AppSession | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    return null;
  }

  return session as AppSession;
}

export function getSessionUserId(session: AppSession) {
  return session.user.id;
}

export function getActiveOrganizationId(session: AppSession) {
  return session.session?.activeOrganizationId || null;
}
