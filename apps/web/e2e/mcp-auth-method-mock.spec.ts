import { test, expect, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

/**
 * The full member-chosen-method flow against a local mock MCP server that,
 * like Arcmira, accepts OAuth or an API key (apps/backend/scripts/
 * mock-oauth-mcp-server-e2e.ts): save a working key and Test with it, switch
 * to OAuth and finish the sign-in, Test with the OAuth token, switch back.
 * The mock records which credential every MCP request carried, so each Test
 * is checked against what actually reached the server. Runs against the
 * isolated skill test deployment with its seeded accounts (e2e/README.md).
 *
 * Issue #367 W1: the same mock also serves an open MCP server, and names a
 * documentation page in its protected-resource metadata, so what federation
 * keeps from the probe is checked on the public catalog too: the open
 * server's tools, the 401 server's "Documentation" link.
 */
const api = process.env.SKILL_E2E_API_URL ?? "http://localhost:3311";
const web = process.env.SKILL_E2E_WEB_URL ?? "http://localhost:3310";
const identifier = "io.github.sourceweft-e2e/mock-oauth-or-key";
const openIdentifier = "io.github.sourceweft-e2e/mock-open";
const API_KEY = "mock_sk_live_e2e";
const DOCUMENTATION_URL = "https://docs.example.com/mock-mcp";
const detailPath = `/dashboard/mcp/${encodeURIComponent(identifier)}`;
const evidenceDir = resolve("../../output/playwright/mcp-auth-method-mock");
const accounts = JSON.parse(
  readFileSync(resolve("../backend/.skills-e2e-accounts.json"), "utf8"),
) as Record<string, { email: string; password: string }>;

let mock: ChildProcess;
let mockOrigin: string;
let session: Awaited<
  ReturnType<Awaited<ReturnType<Browser["newContext"]>>["storageState"]>
>;

async function startMock() {
  mock = spawn(
    "pnpm",
    ["exec", "tsx", "scripts/mock-oauth-mcp-server-e2e.ts"],
    {
      cwd: resolve("../backend"),
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const lines = createInterface({ input: mock.stdout! });
  for await (const line of lines) {
    if (line.startsWith("{"))
      return (JSON.parse(line) as { origin: string }).origin;
  }
  throw new Error("The mock MCP server exited before listening");
}

async function credentialsSeen() {
  const response = await fetch(`${mockOrigin}/_e2e/requests`);
  return (await response.json()) as Array<{
    method: string;
    credential: string;
  }>;
}

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

async function openDetail(page: Page) {
  await page.goto(detailPath, { timeout: 180_000 });
  await expect(
    page
      .getByRole("button", { name: "Install", exact: true })
      .or(page.getByRole("button", { name: "Connection", exact: true }))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

async function openCredentials(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Connection",
  });
  if (!(await dialog.isVisible())) {
    await page.getByRole("button", { name: "Connection", exact: true }).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Runs Test; returns the tool count and the credential the mock saw. */
async function runTest(page: Page) {
  const before = (await credentialsSeen()).length;
  const tested = page.waitForResponse(
    (r) => r.url().includes("/test") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  const response = await tested;
  expect(response.ok(), await response.text()).toBe(true);
  const { toolCount } = (await response.json()) as { toolCount: number };
  const seen = (await credentialsSeen()).slice(before);
  // The "tested" toast sits over the header buttons until it goes, and a
  // pointer resting on it (where Test was clicked) keeps it open.
  await page.mouse.move(10, 400);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 15_000,
  });
  return {
    toolCount,
    credentials: [...new Set(seen.map((r) => r.credential))],
  };
}

async function saveKey(page: Page) {
  const dialog = await openCredentials(page);
  await dialog
    .getByRole("radiogroup", { name: "Connection method" })
    .getByLabel("Use an API key")
    .check();
  await dialog.getByLabel(/Authorization/).fill(API_KEY);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/credentials") && r.request().method() !== "GET",
  );
  await dialog.getByRole("button", { name: "Save" }).click();
  const { install } = await (await saved).json();
  expect(install.connectedVia).toBe("header");
  expect(install.credentialStatus).toBe("configured");
  await expect(dialog).toBeHidden();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mkdirSync(evidenceDir, { recursive: true });
  mockOrigin = await startMock();
  // The OAuth-or-key entry first: the first request the mock records must be
  // its probe. The open entry's requests are not recorded.
  for (const entry of [identifier, openIdentifier]) {
    execFileSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/federate-registry-entry-e2e.ts",
        entry,
        mockOrigin,
      ],
      { cwd: resolve("../backend"), stdio: "inherit" },
    );
  }
  session = await signIn(browser);
});

test.afterAll(() => {
  mock?.kill();
});

test("the catalog probes the mock and declares both methods", async ({
  request,
}) => {
  const response = await request.get(
    `${api}/v1/mcp/${encodeURIComponent(identifier)}/manifest`,
  );
  const { manifest } = await response.json();
  expect(manifest.auth).toMatchObject({
    type: "oauth",
    required: true,
    posture: "required",
  });
  expect(manifest.auth.methods).toEqual([
    { type: "oauth" },
    expect.objectContaining({
      type: "header",
      name: "Authorization",
      scheme: "bearer",
    }),
  ]);
  // The federation probe itself reached the mock without a credential.
  expect((await credentialsSeen())[0]).toEqual({
    method: "initialize",
    credential: "none",
  });
});

test("issue #367: the open mock's self-description comes from the probe", async ({
  page,
  request,
}) => {
  const response = await request.get(
    `${api}/v1/mcp/${encodeURIComponent(openIdentifier)}/manifest`,
  );
  const { manifest, version } = await response.json();
  expect(manifest.auth).toMatchObject({ type: "none", required: false });
  expect(version.provenanceJson.authProbe.result).toBe("open");
  expect(version.provenanceJson.selfDescription).toMatchObject({
    source: "remote-probe",
    serverInfo: { name: "mock-open", title: "Mock open MCP" },
    instructions: "Search before you delete.",
  });
  expect(version.provenanceJson.serverCard).toMatchObject({
    serverInfo: { name: "mock-open" },
  });
  // The catalog lists tools anonymously from https endpoints only (an http
  // or query-carrying URL may be one account's), so the mock's plain-http
  // open server is described but not listed, and so not validated.
  expect(manifest.tools).toEqual([]);
  expect(version.provenanceJson.toolsListing).toBeUndefined();
  expect(version.provenanceJson.validatedAt).toBeUndefined();

  await page.goto(`/mcp/${encodeURIComponent(openIdentifier)}`, {
    timeout: 180_000,
  });
  await expect(page.locator("#tools")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: /^Documentation/ })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: `${evidenceDir}/0-open-described.png`,
    fullPage: true,
  });
});

test("issue #367: the 401 mock's documentation link is shown, never fetched", async ({
  page,
  request,
}) => {
  const response = await request.get(
    `${api}/v1/mcp/${encodeURIComponent(identifier)}/manifest`,
  );
  const { manifest, version } = await response.json();
  expect(manifest.tools).toEqual([]);
  expect(version.provenanceJson.authMetadata).toEqual({
    resourceName: "Mock OAuth-or-key MCP",
    resourceDocumentation: DOCUMENTATION_URL,
  });
  expect(version.provenanceJson.validatedAt).toBeUndefined();

  await page.goto(`/mcp/${encodeURIComponent(identifier)}`, {
    timeout: 180_000,
  });
  const link = page.getByRole("link", { name: /^Documentation/ });
  await expect(link).toBeVisible({ timeout: 60_000 });
  await expect(link).toHaveAttribute("href", DOCUMENTATION_URL);
  await page.screenshot({
    path: `${evidenceDir}/0-documentation-link.png`,
    fullPage: true,
  });
});

test("API key → OAuth → API key, each Test using the chosen credential", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: web,
    storageState: session,
  });
  const page = await context.newPage();

  // 1. Install, choose an API key, Test with it.
  await openDetail(page);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await saveKey(page);
  const withKey = await runTest(page);
  expect(withKey).toEqual({ toolCount: 1, credentials: ["api_key"] });
  await page.screenshot({
    path: `${evidenceDir}/1-key-tested.png`,
    fullPage: true,
  });

  // 2. Switch to OAuth and finish the mock sign-in.
  let dialog = await openCredentials(page);
  await dialog
    .getByRole("radiogroup", { name: "Connection method" })
    .getByLabel("Sign in with OAuth")
    .check();
  await expect(
    dialog.getByText("Switching replaces your current connection."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL(`${mockOrigin}/authorize**`);
  await page.screenshot({ path: `${evidenceDir}/2-mock-sign-in.png` });
  await page.getByRole("link", { name: "Allow" }).click();
  // The callback returns to the page the flow began on, and the confirmed
  // connection reopens the dialog on this member's own tool list.
  await page.waitForURL(
    (url) => url.pathname === decodeURIComponent(detailPath).replace(/\/$/, "") ||
      url.pathname === detailPath,
    { timeout: 60_000 },
  );
  dialog = page.getByRole("dialog", { name: "Connection" });
  await expect(dialog.getByText("1 tool is available to you")).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog.getByText("whoami")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/3-oauth-connected.png` });
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden();
  await openDetail(page);
  dialog = await openCredentials(page);
  await expect(dialog.getByText("Connected with OAuth")).toBeVisible();
  await page.keyboard.press("Escape");
  const withOAuth = await runTest(page);
  expect(withOAuth).toEqual({ toolCount: 1, credentials: ["oauth"] });

  // 3. Back to the API key: saving it replaces the OAuth session.
  await saveKey(page);
  const keyAgain = await runTest(page);
  expect(keyAgain).toEqual({ toolCount: 1, credentials: ["api_key"] });
  dialog = await openCredentials(page);
  await expect(dialog.getByText("Connected with an API key")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/4-key-again.png` });
  await context.close();
});
