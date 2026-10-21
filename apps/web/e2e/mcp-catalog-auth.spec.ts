import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Issue #337: a federated MCP server whose registry entry declares an
 * `Authorization` header and whose endpoint answers an unauthenticated
 * initialize with an OAuth challenge must be listed as "OAuth or API key",
 * not "Not required".
 *
 * Runs against the isolated skill test deployment (see e2e/README.md): the
 * live registry entry is federated through the real ingest first, which also
 * probes the live endpoint. Both upstreams are real, so the precondition test
 * says when Arcmira itself changed rather than SourceWeft.
 */
const api = process.env.SKILL_E2E_API_URL ?? "http://localhost:3311";
const identifier = "io.github.arcmira/arcmira";
const endpointUrl = "https://mcp.arcmira.com/mcp";
const pagePath = `/mcp/${encodeURIComponent(identifier)}`;
const evidenceDir = resolve("../../output/playwright/mcp-catalog-auth");

async function authCardValue(page: Page, label: string) {
  const term = page.locator("aside dl dt", { hasText: new RegExp(`^${label}$`) });
  await expect(term).toHaveCount(1);
  return term.locator("xpath=following-sibling::dd[1]");
}

test.beforeAll(() => {
  mkdirSync(evidenceDir, { recursive: true });
  execFileSync(
    "pnpm",
    ["exec", "tsx", "scripts/federate-registry-entry-e2e.ts", identifier],
    { cwd: resolve("../backend"), stdio: "inherit" },
  );
});

test("upstream precondition: the endpoint challenges for OAuth", async ({
  request,
}) => {
  const response = await request.post(endpointUrl, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sourceweft-e2e", version: "1" },
      },
    },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toContain("resource_metadata=");
});

test("catalog manifest records OAuth with the Authorization header", async ({
  request,
}) => {
  const response = await request.get(
    `${api}/v1/mcp/${encodeURIComponent(identifier)}/manifest`,
  );
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.item.requiresAuth).toBe(true);
  expect(body.manifest.auth).toMatchObject({
    type: "oauth",
    required: true,
    headerName: "Authorization",
    allowedHeaderNames: ["Authorization"],
  });
});

for (const { locale, prefix, label, value } of [
  { locale: "en", prefix: "", label: "Auth", value: "OAuth or API key" },
  { locale: "zh-CN", prefix: "/zh-CN", label: "鉴权", value: "OAuth 或 API 密钥" },
  { locale: "zh-TW", prefix: "/zh-TW", label: "驗證方式", value: "OAuth 或 API 金鑰" },
]) {
  test(`public page shows "${value}" (${locale})`, async ({ page }) => {
    await page.goto(`${prefix}${pagePath}`);
    await expect(await authCardValue(page, label)).toHaveText(value);
    await page
      .locator("aside")
      .first()
      .screenshot({ path: `${evidenceDir}/auth-card-${locale}.png` });
  });
}
