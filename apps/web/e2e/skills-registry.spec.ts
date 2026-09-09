import {
  test,
  expect,
  request,
  type Page,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { RegistrySkillResult } from "@sourceweft/contracts";
const api = process.env.SKILL_E2E_API_URL ?? "http://localhost:3311";
const web = process.env.SKILL_E2E_WEB_URL ?? "http://localhost:3310";
const defaultSource =
  "https://github.com/cisco-ai-defense/skill-scanner/tree/431cb58a5ac333bc0bb9aaa23f7c30ac628f59f8/evals/test_skills/safe/simple-formatter";
const accounts = JSON.parse(
  readFileSync(resolve("../backend/.skills-e2e-accounts.json"), "utf8"),
) as Record<string, { email: string; password: string }>;
const fixtures: {
  sourceA?: string;
  name?: string;
  title?: string;
  mixed?: string;
  invalid?: string;
  spoof?: string;
  versionB?: string;
  versionC?: string;
  fileHashes?: Record<string, string>;
} = process.env.SKILL_E2E_FIXTURES_FILE
  ? JSON.parse(readFileSync(process.env.SKILL_E2E_FIXTURES_FILE, "utf8"))
  : {};
const source = fixtures.sourceA ?? defaultSource;
const skillName = fixtures.name ?? "simple-formatter",
  skillTitle = fixtures.title ?? "Simple Formatter";
if (
  process.env.SKILL_E2E_REQUIRE_ALL === "1" &&
  (!fixtures.sourceA ||
    !fixtures.name ||
    !fixtures.title ||
    !fixtures.mixed ||
    !fixtures.invalid ||
    !fixtures.spoof ||
    !fixtures.versionB ||
    !fixtures.versionC)
)
  throw new Error(
    "Full E2E is BLOCKED: sourceA/name/title, mixed, invalid, spoof, changed-content versionB and review versionC fixture URLs are required",
  );
let admin: APIRequestContext;
const sessions: Record<
  string,
  Awaited<ReturnType<BrowserContext["storageState"]>>
> = {};

async function authenticate(browser: Browser, role: string) {
  const context = await browser.newContext({ baseURL: web });
  try {
    const page = await context.newPage();
    const ready = page.waitForResponse(
      (r) => r.url().includes("/api/auth/get-session") && r.status() === 200,
      { timeout: 60000 },
    );
    await Promise.all([ready, page.goto("/auth/sign-in")]);
    await page.getByLabel("Email", { exact: true }).fill(accounts[role]!.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(accounts[role]!.password);
    const signIn = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/sign-in/email") &&
        r.request().method() === "POST",
      { timeout: 30000 },
    );
    const [response] = await Promise.all([
      signIn,
      page.getByRole("button", { name: "Login", exact: true }).click(),
    ]);
    expect(
      response.status(),
      `Normal ${role} login must succeed; do not disable authentication/rate limits`,
    ).toBe(200);
    await expect(page).not.toHaveURL(/\/auth\/sign-in/, { timeout: 45000 });
    return await context.storageState();
  } finally {
    await context.close();
  }
}

test.beforeAll(async ({ browser }) => {
  // Authenticate once per real account. New contexts reuse genuine session
  // cookies instead of repeatedly hitting the sign-in endpoint in every case.
  sessions.owner = await authenticate(browser, "owner");
  sessions.other = await authenticate(browser, "other");
  admin = await request.newContext({
    baseURL: api,
    timeout: 30000,
    extraHTTPHeaders: { Origin: web },
  });
  const r = await admin.post("/api/auth/sign-in/email", {
    data: accounts.admin,
  });
  expect(r.status(), "Normal administrator login").toBe(200);
});
test.afterAll(async () => {
  await admin?.dispose();
});
test.beforeEach(() => {
  execFileSync("pnpm", ["exec", "tsx", "scripts/reset-skills-e2e.ts"], {
    cwd: resolve("../backend"),
    stdio: "pipe",
    timeout: 30000,
  });
});
async function login(page: Page, role = "owner") {
  await page.context().addCookies(sessions[role]!.cookies);
  const ready = page.waitForResponse(
    (r) =>
      /\/v1\/workspaces\/[^/]+\/skills\/catalog$/.test(r.url()) &&
      r.status() === 200,
    { timeout: 60000 },
  );
  const [catalog] = await Promise.all([ready, page.goto("/dashboard/skills")]);
  await expect(
    page.getByRole("button", { name: "Submit skill", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  return new URL(catalog.url()).pathname.split("/")[3]!;
}
async function submit(page: Page, url = source) {
  await page.getByRole("button", { name: "Submit skill", exact: true }).click();
  await page.getByLabel("GitHub skill repository").fill(url);
  const wait = page.waitForResponse(
    (r) =>
      r.url().endsWith("/skills/registry/submit") &&
      r.request().method() === "POST",
    { timeout: 90000 },
  );
  const [response] = await Promise.all([
    wait,
    page.getByRole("button", { name: "Submit", exact: true }).click(),
  ]);
  return {
    response,
    body: (await response.json()) as {
      skills?: RegistrySkillResult[];
      details?: { skills: RegistrySkillResult[] };
    },
  };
}
async function publish(item: RegistrySkillResult) {
  if (item.status === "indexed") return;
  const r = await admin.post(
    `/v1/skills/registry/admin/submissions/${item.skillVersionId}/publish`,
    { data: {} },
  );
  expect(r.ok(), await r.text()).toBeTruthy();
}
async function closeResult(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
}
async function openFormatter(page: Page) {
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", { name: skillTitle, exact: true }),
    })
    .getByRole("button")
    .first()
    .click();
  await expect(
    page.getByRole("region", { name: "Skill versions" }),
  ).toBeVisible();
}

test("E1 real GitHub import, review, version details and install", async ({
  page,
}) => {
  const ws = await login(page);
  const { response, body } = await submit(page);
  expect(response.status()).toBe(201);
  const item = body.skills![0]!;
  expect(item).toMatchObject({
    name: skillName,
    version: new URL(source).pathname.split("/")[4]!.slice(0, 12),
  });
  expect(["indexed", "queued"]).toContain(item.status);
  await expect(
    page.getByRole("region", { name: "Import results" }),
  ).toContainText(item.status === "queued" ? "1 awaiting review" : "1 indexed");
  await publish(item);
  await closeResult(page);
  await page.reload();
  await openFormatter(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Install", exact: true }),
  ).toBeEnabled();
  const installation = page.waitForResponse(
    (r) =>
      r.url() === `${api}/v1/workspaces/${ws}/skills` &&
      r.request().method() === "POST",
  );
  const [installResponse] = await Promise.all([
    installation,
    dialog.getByRole("button", { name: "Install", exact: true }).click(),
  ]);
  expect(installResponse.status()).toBe(201);
  const installed = await page.request.get(`${api}/v1/workspaces/${ws}/skills`);
  expect(installed.ok()).toBeTruthy();
  expect(
    (await installed.json()).items.some(
      (s: { skillVersionId: string }) =>
        s.skillVersionId === item.skillVersionId,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "../../output/playwright/skill-version-installed.png",
    fullPage: true,
  });
});
test("E2 mixed malformed fixtures return every item", async ({ page }) => {
  test.skip(
    !fixtures.mixed,
    "BLOCKED: fixed public mixed fixture URL not supplied",
  );
  const ws = await login(page);
  const { response, body } = await submit(page, fixtures.mixed!);
  expect(response.status()).toBe(201);
  expect(body.skills!.some((s) => s.status === "failed")).toBeTruthy();
  expect(body.skills!.some((s) => s.status === "indexed")).toBeTruthy();
  if (fixtures.fileHashes) {
    expect(body.skills).toHaveLength(5);
    expect(body.skills!.filter((s) => s.status === "indexed")).toHaveLength(4);
    expect(body.skills!.filter((s) => s.status === "failed")).toHaveLength(1);
    const catalog = await page.request.get(
      `${api}/v1/workspaces/${ws}/skills/catalog`,
    );
    const rows = (await catalog.json()).items;
    for (const item of body.skills!.filter((s) => s.status !== "failed")) {
      const row = rows.find(
        (v: { skillVersionId: string }) =>
          v.skillVersionId === item.skillVersionId,
      );
      const response = await page.request.get(
        `${api}/v1/workspaces/${ws}/skills/catalog/${encodeURIComponent(row.catalogId)}/versions/${item.skillVersionId}`,
      );
      expect(response.status()).toBe(200);
      const detail = await response.json();
      const expected = fixtures.fileHashes[`${item.sourcePath}/SKILL.md`];
      expect(
        detail.files.find((f: { path: string }) => f.path === "SKILL.md")
          .contentHash,
      ).toBe(expected);
      expect(
        createHash("sha256").update(detail.skillContent).digest("hex"),
      ).toBe(expected);
      expect(detail.version.diagnostics).toEqual(item.diagnostics);
    }
    const broken = body.skills!.find((s) => s.status === "failed")!;
    expect(broken.diagnostics[0]).toMatchObject({
      code: "SKILL_YAML_INVALID",
      file: "SKILL.md",
    });
    expect(broken.diagnostics[0]!.line).toBeGreaterThan(0);
    expect(
      body.skills!.some((s) =>
        s.diagnostics.some((d) => d.code === "FILE_EXCLUDED"),
      ),
    ).toBeTruthy();
    expect(
      body.skills!.some((s) =>
        s.diagnostics.some((d) => d.code === "DESCRIPTION_SUMMARIZED"),
      ),
    ).toBeTruthy();
  }
  await expect(
    page.getByRole("region", { name: "Import results" }),
  ).toContainText("failed");
});
test("E3 malformed-only fixture permits correction", async ({ page }) => {
  test.skip(
    !fixtures.invalid,
    "BLOCKED: fixed invalid fixture URL not supplied",
  );
  await login(page);
  const { response, body } = await submit(page, fixtures.invalid!);
  expect(response.status()).toBe(422);
  expect(body.details!.skills.every((s) => s.status === "failed")).toBeTruthy();
  await closeResult(page);
  expect((await submit(page)).response.status()).toBe(201);
});
test("E4 builtin contracts and public capability spoof remain distinct", async ({
  page,
}) => {
  test.skip(
    !fixtures.spoof,
    "BLOCKED: public inert capability-spoof fixture URL not supplied",
  );
  const ws = await login(page);
  const catalog = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog`,
  );
  const items = (await catalog.json()).items;
  expect(
    items.some(
      (s: { slug: string; sourceType: string }) =>
        s.slug === "feynman" && s.sourceType === "builtin",
    ),
  ).toBeTruthy();
  const result = await submit(page, fixtures.spoof!);
  expect(result.response.status()).toBe(201);
  const fresh = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog`,
  );
  const external = (await fresh.json()).items.find(
    (item: { slug: string }) => item.slug === result.body.skills![0]!.slug,
  );
  expect(external).toMatchObject({
    sourceType: "registry_github",
    publisher: "Community",
    verified: false,
  });
  expect(external.tools ?? []).not.toContain("generate_image");
});
test("E5 repeat import is immutable and other user cannot claim it", async ({
  page,
  browser,
}) => {
  await login(page);
  const first = await submit(page);
  await publish(first.body.skills![0]!);
  await closeResult(page);
  const again = await submit(page);
  expect(again.body.skills![0]).toMatchObject({
    skillVersionId: first.body.skills![0]!.skillVersionId,
    status: "indexed",
  });
  const context = await browser.newContext({ baseURL: web });
  const other = await context.newPage();
  await login(other, "other");
  const rejected = await submit(other);
  expect(rejected.response.status()).toBe(422);
  await expect(
    other.getByRole("region", { name: "Import results" }),
  ).toContainText("failed");
  await context.close();
});
test("E6 published B leaves A installed until explicit switch and rollback", async ({
  page,
}) => {
  test.skip(
    !fixtures.versionB,
    "BLOCKED: same-skill changed-content B fixture URL not supplied",
  );
  const ws = await login(page);
  const a = (await submit(page)).body.skills![0]!;
  await publish(a);
  await closeResult(page);
  const catalog = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog`,
  );
  const row = (await catalog.json()).items.find(
    (s: { skillVersionId: string }) => s.skillVersionId === a.skillVersionId,
  );
  expect(
    (
      await page.request.post(`${api}/v1/workspaces/${ws}/skills`, {
        data: { skillId: row.skillId, skillVersionId: a.skillVersionId },
      })
    ).ok(),
  ).toBeTruthy();
  const before = await page.request.get(`${api}/v1/workspaces/${ws}/skills`);
  const pin = (await before.json()).items.find(
    (v: { skillVersionId: string }) => v.skillVersionId === a.skillVersionId,
  );
  const config = { fixtureNote: "preserve through upgrade and rollback" };
  expect(
    (
      await page.request.patch(
        `${api}/v1/workspaces/${ws}/skills/${pin.workspaceSkillId}`,
        { data: { enabled: false, configJson: config } },
      )
    ).status(),
  ).toBe(200);
  const b = (await submit(page, fixtures.versionB!)).body.skills![0]!;
  const still = await page.request.get(`${api}/v1/workspaces/${ws}/skills`);
  expect(
    (await still.json()).items.find(
      (v: { workspaceSkillId: string }) =>
        v.workspaceSkillId === pin.workspaceSkillId,
    ),
  ).toMatchObject({
    skillVersionId: a.skillVersionId,
    enabled: false,
    configJson: config,
  });
  if (b.status === "queued") await publish(b);
  await closeResult(page);
  await page.reload();
  await openFormatter(page);
  await page
    .getByLabel("Version", { exact: true })
    .selectOption(b.skillVersionId!);
  await expect(
    page.getByRole("button", { name: "Use selected version" }),
  ).toBeEnabled();
  const switchResponse = page.waitForResponse(
    (r) => r.url().endsWith("/version") && r.request().method() === "PUT",
    { timeout: 30000 },
  );
  const [switched] = await Promise.all([
    switchResponse,
    page.getByRole("button", { name: "Use selected version" }).click(),
  ]);
  expect(switched.status()).toBe(200);
  expect((await switched.json()).workspaceSkill).toMatchObject({
    skillVersionId: b.skillVersionId,
    enabled: false,
    configJson: config,
  });
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Writer B", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Version", { exact: true })
    .selectOption(a.skillVersionId!);
  await expect(
    page.getByRole("button", { name: "Use selected version" }),
  ).toBeEnabled();
  const rollbackResponse = page.waitForResponse(
    (r) => r.url().endsWith("/version") && r.request().method() === "PUT",
    { timeout: 30000 },
  );
  const [rolledBack] = await Promise.all([
    rollbackResponse,
    page.getByRole("button", { name: "Use selected version" }).click(),
  ]);
  expect(rolledBack.status()).toBe(200);
  expect((await rolledBack.json()).workspaceSkill).toMatchObject({
    skillVersionId: a.skillVersionId,
    enabled: false,
    configJson: config,
  });
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Writer A", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "SKILL.md", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Writer A", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../output/playwright/skill-version-rollback.png",
    fullPage: true,
  });
  const latest = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog`,
  );
  expect(
    (await latest.json()).items.find(
      (v: { skillId: string }) => v.skillId === row.skillId,
    ).skillVersionId,
  ).toBe(b.skillVersionId);
  const installed = await page.request.get(`${api}/v1/workspaces/${ws}/skills`);
  expect(
    (await installed.json()).items.some(
      (s: { skillVersionId: string }) => s.skillVersionId === a.skillVersionId,
    ),
  ).toBeTruthy();
});
test("E7 review reasons persist and revoked versions cannot be installed", async ({
  page,
}) => {
  const ws = await login(page);
  const a = (await submit(page)).body.skills![0]!;
  expect(
    (
      await admin.post(
        `/v1/skills/registry/admin/submissions/${a.skillVersionId}/reject`,
        { data: {} },
      )
    ).status(),
  ).toBe(400);
  await publish(a);
  await closeResult(page);
  if (fixtures.versionC) {
    const pending = (await submit(page, fixtures.versionC)).body.skills![0]!;
    expect(pending.status).toBe("queued");
    const reject = await admin.post(
      `/v1/skills/registry/admin/submissions/${pending.skillVersionId}/reject`,
      { data: { reason: "Fix the test review phrase" } },
    );
    expect(reject.ok()).toBeTruthy();
    await closeResult(page);
  }
  const catalog = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog`,
  );
  const row = (await catalog.json()).items.find(
    (s: { skillVersionId: string }) => s.skillVersionId === a.skillVersionId,
  );
  expect(
    (
      await admin.post(
        `/v1/skills/registry/admin/submissions/${a.skillVersionId}/reject`,
        { data: { reason: "E2E revoked sample" } },
      )
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post(`${api}/v1/workspaces/${ws}/skills`, {
        data: { skillId: row.skillId, skillVersionId: a.skillVersionId },
      })
    ).status(),
  ).toBe(404);
  const d = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog/${encodeURIComponent(row.catalogId)}/versions/${a.skillVersionId}`,
  );
  expect((await d.json()).version.moderation.reason).toBe("E2E revoked sample");
  const repeat = await submit(page);
  expect(repeat.response.status()).toBe(422);
  await expect(
    page.getByRole("region", { name: "Import results" }),
  ).toContainText("revoked");
});
test("E8 published is not public; explicit admin visibility controls history access", async ({
  page,
  browser,
}) => {
  const ws = await login(page);
  const a = (await submit(page)).body.skills![0]!;
  await publish(a);
  await closeResult(page);
  if (fixtures.versionB) {
    const b = (await submit(page, fixtures.versionB)).body.skills![0]!;
    await publish(b);
    await closeResult(page);
  }
  const own = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog`,
  );
  const row = (await own.json()).items.find(
    (s: { slug: string }) => s.slug === a.slug,
  );
  const context = await browser.newContext({ baseURL: web });
  const other = await context.newPage();
  const otherWs = await login(other, "other");
  const url = `${api}/v1/workspaces/${otherWs}/skills/catalog/${encodeURIComponent(row.catalogId)}/versions`;
  expect((await other.request.get(url)).status()).toBe(404);
  expect(
    (
      await other.request.put(
        `${api}/v1/skills/registry/admin/skills/${row.skillId}/visibility`,
        { data: { visibility: "public" } },
      )
    ).status(),
  ).toBe(403);
  expect(
    (
      await admin.put(
        `/v1/skills/registry/admin/skills/${row.skillId}/visibility`,
        { data: { visibility: "public" } },
      )
    ).ok(),
  ).toBeTruthy();
  const publicHistory = await other.request.get(url);
  expect(publicHistory.status()).toBe(200);
  expect(
    (await publicHistory.json()).items.some(
      (v: { id: string }) => v.id === a.skillVersionId,
    ),
  ).toBeTruthy();
  expect((await other.request.get(`${url}/${a.skillVersionId}`)).status()).toBe(
    200,
  );
  await other.reload();
  await expect(
    other.getByRole("heading", { name: skillTitle, exact: true }),
  ).toBeVisible();
  await context.close();
});
