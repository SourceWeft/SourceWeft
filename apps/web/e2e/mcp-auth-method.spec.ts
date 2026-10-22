import { test, expect, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A member chooses how to connect to a server that accepts OAuth or an API
 * key (Arcmira): save a key, have it sent as `Authorization: Bearer <key>`,
 * then switch to OAuth. Runs against the isolated skill test deployment with
 * its seeded accounts (see e2e/README.md). The key is a dummy, so Arcmira
 * answers that it is not a live key — which is how the test knows the key
 * reached the server in the header it reads, rather than not at all.
 */
const api = process.env.SKILL_E2E_API_URL ?? "http://localhost:3311";
const web = process.env.SKILL_E2E_WEB_URL ?? "http://localhost:3310";
const identifier = "io.github.arcmira/arcmira";
const detailPath = `/dashboard/mcp/${encodeURIComponent(identifier)}`;
const evidenceDir = resolve("../../output/playwright/mcp-auth-method");
const DUMMY_KEY = "arc_sk_e2e_dummy_not_a_live_key";
const accounts = JSON.parse(
  readFileSync(resolve("../backend/.skills-e2e-accounts.json"), "utf8"),
) as Record<string, { email: string; password: string }>;

let session: Awaited<
  ReturnType<Awaited<ReturnType<Browser["newContext"]>>["storageState"]>
>;

async function signIn(browser: Browser) {
  const context = await browser.newContext({ baseURL: web });
  try {
    const page = await context.newPage();
    await page.goto("/auth/sign-in", { timeout: 180_000 });
    await page.getByLabel("Email", { exact: true }).fill(accounts.owner!.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(accounts.owner!.password);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page).not.toHaveURL(/\/auth\/sign-in/, { timeout: 60_000 });
    return await context.storageState();
  } finally {
    await context.close();
  }
}

async function openCredentials(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Configure MCP credentials",
  });
  // Installing a server that needs a credential opens the dialog itself.
  if (await dialog.isVisible()) return dialog;
  // "Settings" opens it whether or not a member is already connected;
  // "Configure credentials" shows only while not.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mkdirSync(evidenceDir, { recursive: true });
  execFileSync(
    "pnpm",
    ["exec", "tsx", "scripts/federate-registry-entry-e2e.ts", identifier],
    { cwd: resolve("../backend"), stdio: "inherit" },
  );
  session = await signIn(browser);
});

test("the catalog declares both methods", async ({ request }) => {
  const response = await request.get(
    `${api}/v1/mcp/${encodeURIComponent(identifier)}/manifest`,
  );
  const { manifest } = await response.json();
  expect(manifest.auth.posture).toBe("required");
  expect(manifest.auth.methods).toEqual([
    { type: "oauth" },
    expect.objectContaining({
      type: "header",
      name: "Authorization",
      scheme: "bearer",
    }),
  ]);
});

test("a member saves an API key and it is sent as a Bearer token", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: web,
    storageState: session,
  });
  const page = await context.newPage();
  await page.goto(detailPath, { timeout: 180_000 });
  const install = page.getByRole("button", { name: "Install", exact: true });
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(install.or(settings).first()).toBeVisible({ timeout: 60_000 });
  if (await install.isVisible()) {
    const installed = page.waitForResponse(
      (r) => r.url().includes("/install") && r.request().method() === "POST",
    );
    await install.click();
    expect((await installed).ok()).toBe(true);
    // A server that needs a credential opens the dialog on install.
    await expect(
      page.getByRole("dialog", { name: "Configure MCP credentials" }),
    ).toBeVisible();
  }

  const dialog = await openCredentials(page);
  const methods = dialog.getByRole("radiogroup", { name: "Connection method" });
  await expect(methods.getByLabel("Sign in with OAuth")).toBeVisible();
  await methods.getByLabel("Use an API key").check();
  await expect(dialog.getByText("Bearer", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/arc_sk_ account key/)).toBeVisible();

  // An empty key is refused before anything is sent.
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("Enter an API key before saving."),
  ).toBeVisible();

  await dialog.getByLabel(/Authorization/).fill(DUMMY_KEY);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/credentials") && r.request().method() !== "GET",
  );
  await dialog.getByRole("button", { name: "Save" }).click();
  const savedResponse = await saved;
  expect(savedResponse.status()).toBe(200);
  const { install: savedInstall } = await savedResponse.json();
  expect(savedInstall.connectedVia).toBe("header");
  expect(savedInstall.credentialStatus).toBe("configured");
  await page.screenshot({
    path: `${evidenceDir}/saved-key.png`,
    fullPage: true,
  });

  // Test sends the saved key: Arcmira says it is not a live key, which it
  // only says when the Authorization header carried one.
  await page.keyboard.press("Escape");
  const tested = page.waitForResponse(
    (r) => r.url().includes("/test") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  const testedResponse = await tested;
  const testedText = await testedResponse.text();
  expect(testedText).not.toContain("No credential was sent");
  await expect(page.getByText(/not a live account key/).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({
    path: `${evidenceDir}/tested-key.png`,
    fullPage: true,
  });
  await context.close();
});

test("switching to OAuth starts Arcmira's sign-in", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: web,
    storageState: session,
  });
  const page = await context.newPage();
  await page.goto(detailPath, { timeout: 180_000 });
  const dialog = await openCredentials(page);
  await expect(dialog.getByText("Connected with an API key")).toBeVisible();
  await dialog
    .getByRole("radiogroup", { name: "Connection method" })
    .getByLabel("Sign in with OAuth")
    .check();
  await expect(
    dialog.getByText("Switching replaces your current connection."),
  ).toBeVisible();
  await page.screenshot({
    path: `${evidenceDir}/switch-to-oauth.png`,
    fullPage: true,
  });

  const started = page.waitForResponse(
    (r) => /oauth/i.test(r.url()) && r.request().method() === "POST",
  );
  // The browser is sent to Arcmira's authorization server, in this page or a
  // popup; the e2e stops there (signing in needs a real Arcmira account).
  const authorize = context.waitForEvent("request", {
    predicate: (r) => new URL(r.url()).host === "api.arcmira.com",
    timeout: 30_000,
  });
  await dialog.getByRole("button", { name: "Connect" }).click();
  expect((await started).status()).toBe(200);
  const authorizeUrl = new URL((await authorize).url());
  expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  await context.close();
});
