import { Hono } from "hono";
import { expect, test } from "vitest";
import { createApiCors } from "./cors";
function preflight(
  origin: string,
  trusted: string[] = ["http://localhost:3310"],
) {
  const app = new Hono();
  app.use("*", createApiCors(trusted));
  return app.request("/api/auth/sign-in/email", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-sw-locale",
    },
  });
}
test("localized cross-origin authentication permits its language header", async () => {
  const response = await preflight("http://localhost:3310");
  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:3310",
  );
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  expect(
    response.headers
      .get("Access-Control-Allow-Headers")
      ?.toLowerCase()
      .split(","),
  ).toContain("x-sw-locale");
});
test.each([
  ["https://untrusted.example", ["http://localhost:3310"]],
  ["http://localhost:3310", []],
] as const)(
  "locale header does not admit untrusted origin %s",
  async (origin, trusted) => {
    const response = await preflight(origin, [...trusted]);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  },
);
test.each([
  "chrome-extension://existing-extension",
  "moz-extension://existing-extension",
])("retains existing extension-origin policy for %s", async (origin) => {
  const response = await preflight(origin);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
});
