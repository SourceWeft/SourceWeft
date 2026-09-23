import { cors } from "hono/cors";

export function createApiCors(trustedOrigins: readonly string[]) {
  return cors({
    origin: (origin) => {
      if (!origin) {
        return "";
      }

      if (
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://")
      ) {
        return origin;
      }

      // Default-deny: an unlisted origin is never reflected. Reflecting an
      // arbitrary origin together with `credentials: true` (as an empty-list
      // fallback used to do) would be a cross-site credential-theft surface,
      // so a misconfigured/empty allow-list must fail closed, not open.
      return trustedOrigins.includes(origin) ? origin : "";
    },
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Workspace-Id",
      "X-Local-Proof",
      "X-SW-Locale",
    ],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: [
      "set-auth-token",
      "set-auth-jwt",
      "content-length",
      "content-disposition",
    ],
    credentials: true,
    maxAge: 600,
  });
}
