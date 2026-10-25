import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

/**
 * The connection flow (Issue #367 A2) against the local mock MCP server of
 * apps/backend/scripts/mock-oauth-mcp-server-e2e.ts, whose `/_e2e/delay` makes
 * a path slow: a stalled or abandoned authorization never leaves a dead
 * spinner, Cancel and the back button recover, the callback returns to the
 * page the flow began on and the member sees their own tools, "Use in chat"
 * only selects the install, and a replayed, forged or off-site callback goes
 * nowhere. Runs against the isolated test deployment (e2e/README.md).
 */
const api = process.env.SKILL_E2E_API_URL ?? "http://localhost:3311";
const web = process.env.SKILL_E2E_WEB_URL ?? "http://localhost:3310";
const identifier = "io.github.sourceweft-e2e/mock-oauth-or-key";
// The member's authorization starts by discovering the issuer here; client
// registration is remembered after the first connect, discovery never is.
const DISCOVERY = "/.well-known/oauth-protected-resource/mcp";
const detailPath = `/dashboard/mcp/${encodeURIComponent(identifier)}`;
const evidenceDir = resolve("../../output/playwright/mcp-oauth-connection");
const accounts = JSON.parse(
  readFileSync(resolve("../backend/.skills-e2e-accounts.json"), "utf8"),
) as Record<string, { email: string; password: string }>;

let mock: ChildProcess;
let mockOrigin: string;
let page: Page;
let ids: { workspaceId: string; installId: string };

async function startMock() {
  mock = spawn(
    "pnpm",
    ["exec", "tsx", "scripts/mock-oauth-mcp-server-e2e.ts"],
    { cwd: resolve("../backend"), stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: mock.stdout! });
  for await (const line of lines) {
    if (line.startsWith("{")) return (JSON.parse(line) as { origin: string }).origin;
  }
  throw new Error("The mock MCP server exited before listening");
}

function delay(path: string, ms: number) {
  return fetch(`${mockOrigin}/_e2e/delay?path=${encodeURIComponent(path)}&ms=${ms}`, {
    method: "POST",
  });
}

const dialog = () => page.getByRole("dialog", { name: "Connection" });
const connect = () => dialog().getByRole("button", { name: "Connect", exact: true });
const spinner = () => dialog().locator(".animate-spin");

/** A toast sits over the header buttons until it goes (and while hovered). */
async function clearToasts() {
  await page.mouse.move(10, 400);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 20_000,
  });
}

async function openDialog() {
  if (!(await dialog().isVisible())) {
    await clearToasts();
    await page.getByRole("button", { name: "Connection", exact: true }).click();
  }
  await expect(dialog()).toBeVisible();
}

async function gotoDetail() {
  await page.goto(detailPath, { timeout: 180_000 });
  await expect(
    page
      .getByRole("button", { name: "Install", exact: true })
      .or(page.getByRole("button", { name: "Connection", exact: true }))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  mkdirSync(evidenceDir, { recursive: true });
  mockOrigin = await startMock();
  for (const entry of [identifier, "io.github.sourceweft-e2e/mock-open"]) {
    execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/federate-registry-entry-e2e.ts", entry, mockOrigin],
      { cwd: resolve("../backend"), stdio: "inherit" },
    );
  }
  const context = await browser.newContext({ baseURL: web });
  const signedIn = await context.request.post(`${api}/api/auth/sign-in/email`, {
    headers: { Origin: web },
    timeout: 120_000,
    data: { email: accounts.owner!.email, password: accounts.owner!.password },
  });
  expect(signedIn.ok()).toBe(true);
  page = await context.newPage();
  await gotoDetail();
  // A run that stopped half way leaves the server installed: start from none.
  const uninstall = page.getByRole("button", { name: "Uninstall", exact: true });
  if (await uninstall.isVisible()) await uninstall.click();
  await expect(
    page.getByRole("button", { name: "Install", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await clearToasts();
  const authorize = page.waitForRequest(
    (r) => r.url().includes("/oauth/authorize"),
    { timeout: 120_000 },
  );
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog()).toBeVisible({ timeout: 90_000 });
  // Learn the workspace and install ids from the first real authorize request.
  await connect().click();
  const request = await authorize;
  const match = request.url().match(/workspaces\/([^/]+)\/mcp-installs\/([^/]+)\/oauth/);
  ids = { workspaceId: match![1]!, installId: match![2]! };
  await page.waitForURL(`${mockOrigin}/authorize**`, { timeout: 60_000 });
});

test.afterAll(async () => {
  await delay(DISCOVERY, 0);
  mock?.kill();
});

test("back from the provider leaves a usable dialog, not a dead spinner", async () => {
  // beforeAll left the browser on the provider's page: go back, as a member would.
  await page.goBack();
  await page.waitForURL(new RegExp(detailPath.replace(/[.%]/g, "\\$&")), { timeout: 60_000 });
  await openDialog();
  await expect(spinner()).toHaveCount(0);
  await expect(connect()).toBeEnabled();
  await page.screenshot({ path: `${evidenceDir}/1-after-back.png` });
});

test("a stalled authorization ends in a clear message at the server's deadline", async () => {
  await delay(DISCOVERY, 60_000);
  await gotoDetail();
  await openDialog();
  await connect().click();
  await expect(dialog().getByText("Contacting the sign-in service…")).toBeVisible();
  await expect(dialog().getByRole("button", { name: "Cancel" }).first()).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/2-requesting.png` });
  await expect(
    dialog().getByText("The sign-in service did not answer in time. Try again."),
  ).toBeVisible({ timeout: 45_000 });
  await expect(spinner()).toHaveCount(0);
  await expect(connect()).toBeEnabled();
  await delay(DISCOVERY, 0);
});

test("Cancel stops a pending connect, and a late answer does not move the page", async () => {
  await delay(DISCOVERY, 8_000);
  await gotoDetail();
  await openDialog();
  await connect().click();
  await dialog().getByRole("button", { name: "Cancel" }).first().click();
  await expect(spinner()).toHaveCount(0);
  await expect(connect()).toBeEnabled();
  await page.waitForTimeout(10_000);
  expect(new URL(page.url()).pathname).toBe(detailPath);
  await delay(DISCOVERY, 0);
});

test("an abandoned navigation recovers instead of spinning forever", async () => {
  // A navigation that never takes the page away (a 204 answer is the plainest
  // case: the browser stays where it is) used to leave the spinner for good.
  const provider = `${mockOrigin}/authorize**`;
  await page.route(provider, (route) => route.fulfill({ status: 204 }));
  await gotoDetail();
  await openDialog();
  await connect().click();
  await expect(dialog().getByText(/^Opening 127\.0\.0\.1/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    dialog().getByText(/The sign-in page did not open\./),
  ).toBeVisible({ timeout: 30_000 });
  await expect(spinner()).toHaveCount(0);
  await expect(connect()).toBeEnabled();
  await page.screenshot({ path: `${evidenceDir}/3-abandoned.png` });
  await page.unroute(provider);
});

test("the callback returns to the starting page; the member sees their own tools and Use in chat only selects", async () => {
  test.setTimeout(420_000);
  await gotoDetail();
  await openDialog();
  await connect().click();
  await page.waitForURL(`${mockOrigin}/authorize**`, { timeout: 60_000 });
  const allow = page.getByRole("link", { name: "Allow" });
  const callbackUrl = (await allow.getAttribute("href"))!;
  await allow.click({ noWaitAfter: true });
  await page.waitForURL((url) => url.pathname === detailPath, {
    timeout: 90_000,
  });
  // The confirmed connection opens the dialog by itself.
  await expect(dialog()).toBeVisible({ timeout: 90_000 });
  await expect(dialog().getByText("1 tool is available to you")).toBeVisible({ timeout: 60_000 });
  await expect(dialog().getByText("whoami")).toBeVisible();
  await expect(dialog().getByText(/Only you see this list/)).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/4-tools.png` });
  // The URL no longer carries the completion flags.
  expect(page.url()).not.toContain("mcpOAuth");

  // Replaying the callback goes to the fixed page and changes nothing.
  const replay = await page.context().request.get(callbackUrl, { maxRedirects: 0 });
  expect(replay.status()).toBe(302);
  expect(replay.headers()["location"]).toBe(`${web}/dashboard/mcp?mcpOAuth=invalid`);

  await dialog().getByRole("button", { name: "Use in chat" }).click();
  // The chat page is compiled on first use by the dev server.
  await page.waitForURL((url) => url.pathname === "/dashboard/chat", {
    timeout: 240_000,
    waitUntil: "commit",
  });
  const selection = await page.evaluate((workspaceId) =>
    window.localStorage.getItem(`chat:mcp:${workspaceId}:current`),
    ids.workspaceId,
  );
  expect(JSON.parse(selection!).installIds).toContain(ids.installId);
});

test("a forged completion flag or reference is not accepted as a connection", async () => {
  for (const query of [
    "mcpOAuth=connected",
    `mcpOAuth=connected&mcpRef=${"0".repeat(32)}`,
  ]) {
    await page.goto(`${detailPath}?${query}`, { timeout: 180_000 });
    await expect(page.getByText("Couldn't confirm the connection.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog()).toHaveCount(0);
  }
});

test("a destination off the site is refused before anything is contacted", async () => {
  for (const returnTo of ["https://evil.example/dashboard/mcp", "//evil.example", "/dashboard/mcp?x=1"]) {
    const response = await page.context().request.post(
      `${api}/v1/workspaces/${ids.workspaceId}/mcp-installs/${ids.installId}/oauth/authorize`,
      { headers: { Origin: web }, data: { returnTo } },
    );
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe("MCP_OAUTH_RETURN_INVALID");
  }
});
