import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const stateFile = process.env.SELFHOST_STATE_FILE!;
const base = process.env.SELFHOST_BASE_URL!;
if (
  !stateFile ||
  !base ||
  !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base)
)
  throw new Error("An isolated selfhost runner is required");

test("README installation: authentication, private upload, streaming, persistence", async ({
  page,
  request,
  browser,
}) => {
  const restart = process.env.SELFHOST_PHASE === "restart";
  const state = restart
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : {
        email: `selfhost-${randomUUID()}@example.com`,
        password: `Test-${randomUUID()}!`,
      };
  const badOrigins: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (
      (url.pathname.startsWith("/v1/") ||
        url.pathname.startsWith("/api/auth/") ||
        url.pathname === "/api/source-file") &&
      url.origin !== base
    )
      badOrigins.push(url.origin);
  });
  if (!restart) {
    const signup = await request.post("/api/auth/sign-up/email", {
      data: {
        name: "Selfhost acceptance",
        email: state.email,
        password: state.password,
      },
      headers: { Origin: base },
    });
    expect(signup.ok(), await signup.text()).toBe(true);
  }
  await page.goto("/auth/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(state.password);
  // The @better-auth-ui sign-in view labels its submit "Sign In" (the old view
  // said "Login"); the other buttons all start with "Continue with".
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await page.waitForURL(/\/dashboard/);
  if (restart) {
    await page.goto(
      state.threadUrl.replace(new URL(state.threadUrl).origin, base),
    );
    await expect(
      page.getByRole("log").getByText("SELFHOST_TEST_OK", { exact: true }),
    ).toBeVisible();
  } else {
    await page.goto("/dashboard/chat");
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add source", exact: true })
      .locator("input[type=file]")
      .setInputFiles({
        name: "selfhost-fixture.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("SELFHOST_FILE_PERSISTENCE"),
      });
    const uploaded = page.waitForResponse(
      (r) =>
        r.url().endsWith("/sources/upload") && r.request().method() === "POST",
      { timeout: 30_000 },
    );
    await page
      .getByRole("button", { name: "Upload files", exact: true })
      .click();
    const response = await uploaded;
    expect(response.ok()).toBe(true);
    const source = (await response.json()).source;
    state.sourceId = source.id;
    state.workspaceId = /\/workspaces\/([^/]+)\//.exec(response.url())![1];
    await expect
      .poll(
        async () => {
          const r = await page.request.get(
            `/v1/workspaces/${state.workspaceId}/sources/${state.sourceId}`,
          );
          return (await r.json()).source.status;
        },
        { timeout: 120000 },
      )
      .toBe("indexed");
    await page
      .getByRole("textbox", {
        name: "Message your documents, links, or connected tools...",
        exact: true,
      })
      .fill("Reply SELFHOST_TEST_OK. No tools.");
    const firstReplyStartedAt = Date.now();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(
      page.getByRole("log").getByText("SELFHOST_TEST_OK", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    console.log(
      `First reply visible after ${Date.now() - firstReplyStartedAt} ms`,
    );
    await expect(
      page.getByRole("button", { name: "Submit", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    state.threadUrl = page.url();
    // Verify cancellation travels through the same-origin proxy too.
    await page
      .getByRole("textbox", {
        name: "Message your documents, links, or connected tools...",
        exact: true,
      })
      .fill("SLOW_SELFHOST");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByRole("log")).toContainText("working", {
      timeout: 30_000,
    });
    const stopStartedAt = Date.now();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("log")).toContainText(
      "Generation stopped by the user.",
      { timeout: 15_000 },
    );
    await expect(
      page.getByRole("button", { name: "Submit", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    console.log(`Composer ready after stop in ${Date.now() - stopStartedAt} ms`);
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  }
  const detail = await page.request.get(
    `/v1/workspaces/${state.workspaceId}/sources/${state.sourceId}`,
  );
  expect(detail.ok()).toBe(true);
  const persistedSource = (await detail.json()).source;
  for (const url of [persistedSource.previewUrl, persistedSource.downloadUrl]) {
    expect(new URL(url).origin).toBe(base);
    expect(new URL(url).pathname).toBe("/api/source-file");
    const file = await page.request.get(url);
    expect(file.ok()).toBe(true);
    expect(await file.text()).toBe("SELFHOST_FILE_PERSISTENCE");
    expect(file.headers()["cache-control"]).toContain("no-store");
  }
  const anonymous = await browser.newContext();
  try {
    const denied = await anonymous.request.get(persistedSource.downloadUrl);
    expect([401, 403]).toContain(denied.status());
  } finally {
    await anonymous.close();
  }
  expect(badOrigins).toEqual([]);
});
