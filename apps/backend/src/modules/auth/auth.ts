import { createSourceweftAuth } from "./auth-config";

export const auth = createSourceweftAuth();

export async function getSession(headers: Headers) {
  return auth.api.getSession({ headers });
}
