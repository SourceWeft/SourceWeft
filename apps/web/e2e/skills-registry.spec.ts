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
import type {
  RegistrySkillResult,
  SkillSubmission,
} from "@sourceweft/contracts";
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
      // The @better-auth-ui sign-in view labels its submit "Sign In" (the old
      // view said "Login"); the other buttons all start with "Continue with".
      page.getByRole("button", { name: "Sign In", exact: true }).click(),
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
      // Match on the path: the gallery pages the catalog, so the URL carries a
      // query string (`?limit=…`).
      /\/v1\/workspaces\/[^/]+\/skills\/catalog$/.test(
        new URL(r.url()).pathname,
      ) && r.status() === 200,
    { timeout: 60000 },
  );
  const [catalog] = await Promise.all([ready, page.goto("/dashboard/skills")]);
  await expect(
    page.getByRole("button", { name: "Submit skill", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  return new URL(catalog.url()).pathname.split("/")[3]!;
}
// Submitting only STARTS a background import. The dialog follows it; the test
// reads the same submission record to its end, so every assertion below is
// about the finished import.
async function submit(page: Page, url = source) {
  await page.getByRole("button", { name: "Submit skill", exact: true }).click();
  await page.getByLabel("GitHub skill repository").fill(url);
  const wait = page.waitForResponse(
    (r) =>
      r.url().endsWith("/skills/registry/submissions") &&
      r.request().method() === "POST",
    { timeout: 30000 },
  );
  const [created] = await Promise.all([
    wait,
    page.getByRole("button", { name: "Submit", exact: true }).click(),
  ]);
  // 202 for a new import, 200 when this source is already being imported.
  expect([200, 202], await created.text()).toContain(created.status());
  let { submission } = (await created.json()) as {
    submission: SkillSubmission;
  };
  const ws = new URL(created.url()).pathname.split("/")[3]!;
  await expect
    .poll(
      async () => {
        const r = await page.request.get(
          `${api}/v1/workspaces/${ws}/skills/registry/submissions/${submission.id}`,
        );
        ({ submission } = (await r.json()) as { submission: SkillSubmission });
        return submission.status;
      },
      { timeout: 180000, intervals: [2000] },
    )
    .toMatch(/^(succeeded|failed)$/);
  return { submission, skills: submission.results as RegistrySkillResult[] };
}
async function publish(item: RegistrySkillResult) {
  if (item.status === "indexed") return;
  const r = await admin.post(
    `/v1/skills/registry/admin/submissions/${item.skillVersionId}/publish`,
    { data: {} },
  );
  expect(r.ok(), await r.text()).toBeTruthy();
}
// The version picker is a custom listbox, not a native <select>: open it and
// choose the option by the short version it displays.
async function pickVersion(page: Page, version: string) {
  await page.getByLabel("Version", { exact: true }).click();
  await page
    .getByRole("option", { name: new RegExp(version.slice(0, 8)) })
    .click();
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
  const { submission, skills } = await submit(page);
  expect(submission.status, JSON.stringify(submission.error)).toBe("succeeded");
  const item = skills[0]!;
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
  const { submission, skills } = await submit(page, fixtures.mixed!);
  const body = { skills };
  expect(submission.status, JSON.stringify(submission.error)).toBe("succeeded");
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
    // Binary files are KEPT now (object storage), not excluded: the fixture's
    // `valid/asset.bin` must be in the stored version's file manifest, and no
    // import may report the old FILE_EXCLUDED diagnostic.
    expect(
      body.skills!.some((s) =>
        s.diagnostics.some((d) => d.code === "FILE_EXCLUDED"),
      ),
    ).toBeFalsy();
    const withAsset = body.skills!.find(
      (s) => s.status !== "failed" && s.sourcePath.endsWith("/valid"),
    )!;
    const assetRow = rows.find(
      (v: { skillVersionId: string }) =>
        v.skillVersionId === withAsset.skillVersionId,
    )!;
    const assetDetail = await (
      await page.request.get(
        `${api}/v1/workspaces/${ws}/skills/catalog/${encodeURIComponent(assetRow.catalogId)}/versions/${withAsset.skillVersionId}`,
      )
    ).json();
    expect(assetDetail.files.map((f: { path: string }) => f.path)).toContain(
      "asset.bin",
    );
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
  const { submission, skills } = await submit(page, fixtures.invalid!);
  expect(submission.status).toBe("failed");
  expect(skills.every((s) => s.status === "failed")).toBeTruthy();
  await closeResult(page);
  expect((await submit(page)).submission.status).toBe("succeeded");
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
  expect(result.submission.status).toBe("succeeded");
  const fresh = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog`,
  );
  const external = (await fresh.json()).items.find(
    (item: { slug: string }) => item.slug === result.skills[0]!.slug,
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
  await publish(first.skills[0]!);
  await closeResult(page);
  const again = await submit(page);
  expect(again.skills[0]).toMatchObject({
    skillVersionId: first.skills[0]!.skillVersionId,
    status: "indexed",
  });
  const context = await browser.newContext({ baseURL: web });
  const other = await context.newPage();
  await login(other, "other");
  const rejected = await submit(other);
  expect(rejected.submission.status).toBe("failed");
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
  const a = (await submit(page)).skills[0]!;
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
  const b = (await submit(page, fixtures.versionB!)).skills[0]!;
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
  await pickVersion(page, b.version!);
  await expect(
    page.getByRole("button", { name: "Use this version" }),
  ).toBeEnabled();
  const switchResponse = page.waitForResponse(
    (r) => r.url().endsWith("/version") && r.request().method() === "PUT",
    { timeout: 30000 },
  );
  const [switched] = await Promise.all([
    switchResponse,
    page.getByRole("button", { name: "Use this version" }).click(),
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
  await pickVersion(page, a.version!);
  await expect(
    page.getByRole("button", { name: "Use this version" }),
  ).toBeEnabled();
  const rollbackResponse = page.waitForResponse(
    (r) => r.url().endsWith("/version") && r.request().method() === "PUT",
    { timeout: 30000 },
  );
  const [rolledBack] = await Promise.all([
    rollbackResponse,
    page.getByRole("button", { name: "Use this version" }).click(),
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
  const a = (await submit(page)).skills[0]!;
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
    const pending = (await submit(page, fixtures.versionC)).skills[0]!;
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
  expect(repeat.submission.status).toBe("failed");
  await expect(
    page.getByRole("region", { name: "Import results" }),
  ).toContainText("revoked");
});
test("E8 published is not public; explicit admin visibility controls history access", async ({
  page,
  browser,
}) => {
  const ws = await login(page);
  const a = (await submit(page)).skills[0]!;
  await publish(a);
  await closeResult(page);
  if (fixtures.versionB) {
    const b = (await submit(page, fixtures.versionB)).skills[0]!;
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

// The chat agent and skills, end to end: browser → API → worker → real model.
// These need a real model, so the isolated deployment must have been prepared
// from a source env that carries a DeepSeek key.
type InstalledSkill = {
  slug: string;
  workspaceSkillId: string;
  enabled: boolean;
  installedVia?: string;
};
function chatModelConfigured() {
  return /^MODEL_GATEWAY_GLOBAL_CONFIG_PATH=/m.test(
    readFileSync(resolve("../backend/.env.skills-test"), "utf8"),
  );
}
const CHAT_BLOCKED =
  "BLOCKED: the test deployment has no model configured (no DeepSeek key in the source env)";
async function installedSkills(page: Page, ws: string) {
  return (
    (await (
      await page.request.get(`${api}/v1/workspaces/${ws}/skills`)
    ).json()) as { items: InstalledSkill[] }
  ).items;
}
async function uninstall(
  page: Page,
  ws: string,
  match: (s: InstalledSkill) => boolean,
) {
  for (const item of (await installedSkills(page, ws)).filter(match))
    expect(
      (
        await page.request.delete(
          `${api}/v1/workspaces/${ws}/skills/${item.workspaceSkillId}`,
        )
      ).ok(),
    ).toBeTruthy();
}
async function say(page: Page, message: string) {
  await page.goto("/dashboard/chat");
  const editor = page
    .getByRole("textbox", {
      name: "Message your documents, links, or connected tools...",
    })
    .filter({ visible: true });
  await editor.waitFor({ timeout: 60000 });
  await editor.fill(message);
  await editor.press("Enter");
}
test("E9 the chat agent installs a catalog skill and uses it in the same turn", async ({
  page,
}) => {
  test.setTimeout(300_000);
  test.skip(!chatModelConfigured(), CHAT_BLOCKED);
  const ws = await login(page);
  const feynman = async () =>
    (await installedSkills(page, ws)).find((item) => item.slug === "feynman");
  // A previous run leaves the builtin installed; start from "not installed".
  await uninstall(page, ws, (item) => item.slug === "feynman");
  expect(await feynman()).toBeUndefined();

  await say(
    page,
    "安装 feynman 这个 skill，然后马上用它给我讲讲 TCP 三次握手，三四句话就行。",
  );

  // The install is the agent's: it lands switched on and marked as such.
  await expect
    .poll(async () => (await feynman())?.installedVia, {
      timeout: 180_000,
      intervals: [2000],
    })
    .toBe("agent");
  expect((await feynman())?.enabled).toBe(true);

  // Same turn: after the install card, the freshly mounted SKILL.md is loaded
  // (the chat renders a /skills read as "Load <skill> skill instructions"),
  // and only then does the answer arrive.
  await expect(page.getByText("Install Skill", { exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/Load Feynman skill instructions/i)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/SYN/).last()).toBeVisible({ timeout: 180_000 });
});

// The user never mentions a skill: the agent has to decide the catalog is worth
// checking, find the match, install it and use it — all in one turn.
test("E10 the chat agent finds and installs a fitting skill on its own", async ({
  page,
}) => {
  test.setTimeout(300_000);
  test.skip(!chatModelConfigured(), CHAT_BLOCKED);
  const ws = await login(page);
  await uninstall(page, ws, (item) => item.slug === "feynman");

  await say(page, "用费曼学习法给我讲讲 TCP 三次握手，三四句话就行。");

  await expect
    .poll(
      async () =>
        (await installedSkills(page, ws)).find((i) => i.slug === "feynman")
          ?.installedVia,
      { timeout: 180_000, intervals: [2000] },
    )
    .toBe("agent");
  await expect(page.getByText(/Load Feynman skill instructions/i)).toBeVisible({
    timeout: 120_000,
  });
  // It must say what it installed rather than use it silently.
  await expect(page.getByText(/feynman/i).last()).toBeVisible({
    timeout: 180_000,
  });
});

// A GitHub link in chat is not in the catalog yet: the agent starts a
// background import (the same one the Submit dialog starts) that installs the
// skill when it finishes — whether or not that is within this turn.
test("E11 a GitHub link given in chat is imported in the background and installed", async ({
  page,
}) => {
  test.setTimeout(300_000);
  test.skip(!chatModelConfigured(), CHAT_BLOCKED);
  test.skip(!fixtures.sourceA, "BLOCKED: fixture A URL not supplied");
  const ws = await login(page);

  await say(page, `帮我安装这个 skill：${fixtures.sourceA}`);

  await expect
    .poll(
      async () =>
        (await installedSkills(page, ws)).find((i) =>
          i.slug.endsWith(`-${fixtures.name}`),
        )?.installedVia,
      { timeout: 240_000, intervals: [3000] },
    )
    .toBe("agent");
  const submissions = (await (
    await page.request.get(
      `${api}/v1/workspaces/${ws}/skills/registry/submissions`,
    )
  ).json()) as { items: SkillSubmission[] };
  expect(submissions.items[0]).toMatchObject({
    sourceInput: fixtures.sourceA,
    status: "succeeded",
  });
});

// Real-world repositories, pinned to a commit so the run is reproducible. These
// exercise what the inert fixtures cannot: binary assets at scale, and a
// repository that ships many skills.
const REAL_WORLD = {
  // 83 files, 54 of them .ttf fonts, ~5.3 MiB — the skill that used to lose
  // every font at ingest because a text column could not hold them.
  canvasDesign:
    "https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/canvas-design",
  // 15 skills under skills/.
  superpowers:
    "https://github.com/obra/superpowers/tree/5bf4e78011075bcfc0dc295f0724994cd123ee71",
};
type VersionDetail = {
  skillContent: string | null;
  contentRestricted?: boolean;
  files: Array<{ path: string; sizeBytes: number; contentHash: string }>;
};
async function versionDetail(
  page: Page,
  ws: string,
  item: RegistrySkillResult,
) {
  const rows = (
    (await (
      await page.request.get(`${api}/v1/workspaces/${ws}/skills/catalog`)
    ).json()) as { items: Array<{ catalogId: string; skillVersionId: string }> }
  ).items;
  const row = rows.find((r) => r.skillVersionId === item.skillVersionId)!;
  const response = await page.request.get(
    `${api}/v1/workspaces/${ws}/skills/catalog/${encodeURIComponent(row.catalogId)}/versions/${item.skillVersionId}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as VersionDetail;
}

test("E12 a real skill with binary assets is pulled from GitHub whole and installs", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const ws = await login(page);
  const { submission, skills } = await submit(page, REAL_WORLD.canvasDesign);
  expect(submission.status, JSON.stringify(submission.error)).toBe("succeeded");
  expect(skills).toHaveLength(1);
  const skill = skills[0]!;
  expect(skill.slug).toBe("gh-anthropics-skills-canvas-design");
  await publish(skill);

  const detail = await versionDetail(page, ws, skill);
  const fonts = detail.files.filter((f) => f.path.endsWith(".ttf"));
  expect(detail.files).toHaveLength(83);
  expect(fonts).toHaveLength(54);
  expect(fonts.every((f) => f.sizeBytes > 0)).toBeTruthy();
  // The submitter may read the instructions it just imported.
  expect(detail.skillContent).toContain("canvas-design");

  await closeResult(page);
  const install = await page.request.post(`${api}/v1/workspaces/${ws}/skills`, {
    data: {
      skillId: (
        (await (
          await page.request.get(`${api}/v1/workspaces/${ws}/skills/catalog`)
        ).json()) as {
          items: Array<{ skillId: string; skillVersionId: string }>;
        }
      ).items.find((r) => r.skillVersionId === skill.skillVersionId)!.skillId,
      skillVersionId: skill.skillVersionId,
    },
  });
  expect(install.status(), await install.text()).toBe(201);
  expect(
    (await installedSkills(page, ws)).find((i) => i.slug === skill.slug)
      ?.enabled,
  ).toBe(true);
});

test("E13 a many-skill repository indexes every skill, and chat installs just the one that was named", async ({
  page,
}) => {
  test.setTimeout(420_000);
  test.skip(!chatModelConfigured(), CHAT_BLOCKED);
  const ws = await login(page);
  const { submission, skills } = await submit(page, REAL_WORLD.superpowers);
  expect(submission.status, JSON.stringify(submission.error)).toBe("succeeded");
  expect(skills).toHaveLength(15);
  expect(skills.filter((s) => s.status === "failed")).toEqual([]);
  await closeResult(page);
  // Importing indexes; it installs nothing unless asked to.
  expect(
    (await installedSkills(page, ws)).filter((i) =>
      i.slug.startsWith("gh-obra-superpowers-"),
    ),
  ).toEqual([]);
  for (const skill of skills) await publish(skill);

  await say(
    page,
    "从 obra/superpowers 这个仓库里只安装 test-driven-development 这一个 skill，别的不要装。",
  );
  await expect
    .poll(
      async () =>
        (await installedSkills(page, ws))
          .filter((i) => i.slug.startsWith("gh-obra-superpowers-"))
          .map((i) => i.slug),
      { timeout: 240_000, intervals: [3000] },
    )
    .toEqual(["gh-obra-superpowers-test-driven-development"]);
});

// A skill's own files, really inside the cloud sandbox. The model is asked for
// the sha256 of the skill's script as computed IN the sandbox; it cannot guess
// a digest, so a match with the hash recorded at ingest proves both that the
// bundle reached the sandbox byte-for-byte from object storage and that the
// command actually ran there.
function sandboxConfigured() {
  return /^SOURCEWEFT_SANDBOX_ENABLED="?true/m.test(
    readFileSync(resolve("../backend/.env.skills-test"), "utf8"),
  );
}
const SANDBOX_BLOCKED =
  "BLOCKED: the test deployment has no sandbox provider configured";
async function importFormatter(page: Page, ws: string) {
  const { submission, skills } = await submit(page, defaultSource);
  expect(submission.status, JSON.stringify(submission.error)).toBe("succeeded");
  const skill = skills[0]!;
  await publish(skill);
  const detail = await versionDetail(page, ws, skill);
  await closeResult(page);
  const scriptHash = detail.files.find(
    (f) => f.path === "formatter.py",
  )!.contentHash;
  expect(scriptHash).toMatch(/^[0-9a-f]{64}$/);
  return { skill, scriptHash };
}
const hashPrompt = (slug: string) =>
  `在沙箱里执行 sha256sum /skills/${slug}/formatter.py ，再用 python3 运行这个文件，把两条命令的原始输出原样告诉我。必须真的执行，不要推测。`;

// The sandbox is an external provider reached over the network; one connection
// reset there must not turn the whole acceptance run red. These two cases — and
// only these — get a single retry.
test.describe("cloud sandbox", () => {
  test.describe.configure({ retries: 1 });

  test("E14 an installed skill's script runs in the cloud sandbox", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    test.skip(!chatModelConfigured(), CHAT_BLOCKED);
    test.skip(!sandboxConfigured(), SANDBOX_BLOCKED);
    const ws = await login(page);
    const { skill, scriptHash } = await importFormatter(page, ws);
    const catalog = (
      (await (
        await page.request.get(`${api}/v1/workspaces/${ws}/skills/catalog`)
      ).json()) as { items: Array<{ skillId: string; skillVersionId: string }> }
    ).items.find((r) => r.skillVersionId === skill.skillVersionId)!;
    expect(
      (
        await page.request.post(`${api}/v1/workspaces/${ws}/skills`, {
          data: {
            skillId: catalog.skillId,
            skillVersionId: skill.skillVersionId,
          },
        })
      ).status(),
    ).toBe(201);

    await say(page, hashPrompt(skill.slug!));
    await expect(page.getByText(scriptHash).last()).toBeVisible({
      timeout: 480_000,
    });
    await expect(
      page.getByText("Hello world this is a test.").last(),
    ).toBeVisible();
  });

  // The skill is NOT installed when the turn starts: the agent installs it and
  // runs its script in the same turn, so the bundle has to be staged into a
  // sandbox that was set up before the skill existed for this workspace.
  test("E15 a skill installed mid-turn has its script staged and run in that same turn", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    test.skip(!chatModelConfigured(), CHAT_BLOCKED);
    test.skip(!sandboxConfigured(), SANDBOX_BLOCKED);
    const ws = await login(page);
    const { skill, scriptHash } = await importFormatter(page, ws);
    expect(
      (await installedSkills(page, ws)).find((i) => i.slug === skill.slug),
    ).toBeUndefined();

    await say(
      page,
      `先安装 ${skill.slug} 这个 skill，装好后在同一轮里：${hashPrompt(skill.slug!)}`,
    );
    await expect
      .poll(
        async () =>
          (await installedSkills(page, ws)).find((i) => i.slug === skill.slug)
            ?.installedVia,
        { timeout: 180_000, intervals: [2000] },
      )
      .toBe("agent");
    await expect(page.getByText(scriptHash).last()).toBeVisible({
      timeout: 480_000,
    });
  });
});
