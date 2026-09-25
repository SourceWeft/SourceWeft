import { Hono } from "hono";
import {
  ApiError,
  ApiResponse,
  toApiError,
} from "../api/response/api-response";

// Shared harness for route tests. `register` is the module's own
// register…Routes function (or a callback adding several); the app gets the
// API's standard not-found and error handlers so responses look like
// production's.

export function createRouteTestApp(register: (app: Hono) => void): Hono {
  const app = new Hono();
  register(app);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

/** Content routes live under a workspace; mount them the way app.ts does. */
export function createWorkspaceRouteTestApp(
  register: (app: Hono) => void,
): Hono {
  return createRouteTestApp((app) => {
    const workspaceRoutes = new Hono();
    register(workspaceRoutes);
    app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  });
}

export function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

export type StubSession = {
  user: { id: string; email?: string; name?: string };
  session: { id: string; userId: string };
};

export function stubSession(userId: string): StubSession {
  return {
    user: { id: userId, email: `${userId}@example.com`, name: userId },
    session: { id: `session_${userId}`, userId },
  };
}

/**
 * Bodies for `vi.mock(".../middleware/auth-session", ...)` factories. A factory
 * cannot see the file's imports, so reach these with a dynamic import:
 * `vi.mock(path, async () => (await import("../../test/hono")).signedInAs("user_1"))`.
 */
export function signedInAs(userId: string) {
  return {
    getSessionUserId: () => userId,
    requireSession: async () => stubSession(userId),
  };
}

/** Same, but `state.signedIn` decides per request whether there is a session. */
export function signedInWhen(userId: string, state: { signedIn: boolean }) {
  return {
    getSessionUserId: () => userId,
    requireSession: async () => (state.signedIn ? stubSession(userId) : null),
  };
}
