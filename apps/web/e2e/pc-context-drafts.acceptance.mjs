// Run from the repository root in an authenticated playwright-cli session.
export default async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const editor = () =>
    page
      .getByRole("textbox", {
        name: "Message your documents, links, or connected tools...",
      })
      .filter({ visible: true });
  const images = () =>
    page.locator(".chat-composer:visible [data-composer-attachments] img");
  await page.goto("http://localhost:3300/dashboard/chat");
  await editor().waitFor();
  await page.waitForURL(/draft=/);
  const draftUrl = page.url();
  await editor().fill("刷新后保留的云端草稿");
  await page
    .locator(".chat-composer:visible input[type=file]")
    .setInputFiles("apps/desktop/src-tauri/icons/32x32.png");
  await images().first().waitFor();
  const waitSaved = async (text, count) => {
    const context = await page.evaluate(() => {
      const url = new URL(location.href);
      return {
        draft: url.searchParams.get("draft"),
        computer: url.searchParams.get("computer") ?? "cloud",
      };
    });
    await page.waitForFunction(
      async ({ draft, computer, text, count }) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("sourceweft-chat-drafts", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const keys = await new Promise((resolve, reject) => {
            const request = db
              .transaction("drafts", "readonly")
              .objectStore("drafts")
              .getAllKeys();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const key = keys.find(
            (key) =>
              typeof key === "string" &&
              key.includes(`:${draft}:`) &&
              key.endsWith(`:${computer}`),
          );
          if (!key) return false;
          const record = await new Promise((resolve, reject) => {
            const request = db
              .transaction("drafts", "readonly")
              .objectStore("drafts")
              .get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          return (
            record?.text === text &&
            record.files.length === count &&
            record.files.every((file) => file.blob.size > 0)
          );
        } finally {
          db.close();
        }
      },
      { ...context, text, count },
    );
  };
  await waitSaved("刷新后保留的云端草稿", 1);
  await page.reload();
  await editor().waitFor();
  assert(
    (await editor().innerText()).trim() === "刷新后保留的云端草稿",
    "Text was not restored",
  );
  await images().first().waitFor();
  assert(
    await images()
      .first()
      .evaluate(async (img) => {
        await img.decode();
        return img.naturalWidth > 0;
      }),
    "Restored image is not readable",
  );
  assert(page.url() === draftUrl, "Reload changed draft identity");
  await page.getByRole("button", { name: "选择云端或电脑" }).click();
  await page.getByRole("button", { name: /我的 Mac.*离线/ }).click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get("computer") !== null &&
      url.searchParams.get("computer") !== "cloud",
  );
  await page
    .getByRole("button", { name: "选择云端或电脑" })
    .filter({ hasText: "我的 Mac" })
    .waitFor();
  await editor().waitFor();
  assert(
    (await editor().innerText()).trim() === "",
    "Local draft inherited cloud text",
  );
  assert(
    (await images().count()) === 0,
    "Local draft inherited cloud attachment",
  );
  await editor().fill("刷新后保留的本地草稿");
  await waitSaved("刷新后保留的本地草稿", 0);
  await page.reload();
  await editor().waitFor();
  assert(
    (await editor().innerText()).trim() === "刷新后保留的本地草稿",
    "Local text was not restored",
  );
  assert(
    (await images().count()) === 0,
    "Local reload inherited another draft's attachment",
  );
  await page.getByRole("button", { name: "选择云端或电脑" }).click();
  await page.getByRole("button", { name: "云端工作", exact: true }).click();
  await page.waitForURL(/computer=cloud/);
  await page
    .getByRole("button", { name: "选择云端或电脑" })
    .filter({ hasText: "云端工作" })
    .waitFor();
  await editor().waitFor();
  assert(
    (await editor().innerText()).trim() === "刷新后保留的云端草稿",
    "Returning to cloud lost its draft",
  );
  const other = await page.context().newPage();
  await other.goto("http://localhost:3300/dashboard/chat");
  const fresh = other
    .getByRole("textbox", {
      name: "Message your documents, links, or connected tools...",
    })
    .filter({ visible: true });
  await fresh.waitFor();
  await other.waitForURL(/draft=/);
  assert(
    (await fresh.innerText()).trim() === "",
    "Fresh tab inherited another draft",
  );
  assert(
    (await other.evaluate(() =>
      new URL(location.href).searchParams.get("draft"),
    )) !==
      (await page.evaluate(() =>
        new URL(location.href).searchParams.get("draft"),
      )),
    "Fresh tab reused another draft identity",
  );
  await other.close();
  const before = await editor().innerText();
  const old = await editor().elementHandle();
  await page.context().setOffline(true);
  try {
    await page
      .getByRole("button", { name: "Submit", exact: true })
      .filter({ visible: true })
      .click();
    await page.waitForFunction((el) => !el.isConnected, old);
    await editor().waitFor();
    assert(
      (await editor().innerText()).trim() === before.trim(),
      "Failed submission lost text",
    );
    await images().first().waitFor();
    assert(
      await images()
        .first()
        .evaluate(async (img) => {
          await img.decode();
          return img.naturalWidth > 0;
        }),
      "Failed submission lost attachment",
    );
  } finally {
    await page.context().setOffline(false);
  }
  const oldUrl = page.url();
  const oldEditor = await editor().elementHandle();
  const show = page.getByRole("button", {
    name: "Show conversations",
    exact: true,
  });
  if (await show.count()) await show.click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForURL((url) => url.href !== oldUrl);
  await page.waitForFunction((el) => !el.isConnected, oldEditor);
  await editor().waitFor();
  assert(
    (await editor().innerText()).trim() === "",
    "New chat inherited old draft text",
  );
  assert((await images().count()) === 0, "New chat inherited an attachment");
  await page
    .getByRole("button", { name: "选择云端或电脑" })
    .filter({ hasText: "云端工作" })
    .waitFor();
  await page.goBack();
  await page.waitForURL(oldUrl);
  await editor().waitFor();
  assert(
    (await editor().innerText()).trim() === before.trim(),
    "Back navigation lost the earlier draft",
  );
  await images().first().waitFor();
  return {
    textRestored: true,
    attachmentBytesRestored: true,
    modeIsolation: true,
    freshTabIsolated: true,
    failedSubmissionPreserved: true,
    newDraftIsolated: true,
    historyDraftRestored: true,
  };
};
