/* global document, innerWidth */
// Real, authenticated Web UI checks. No API mocks or injected native bridge.
// Run through playwright-cli run-code with an existing local conversation open.
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
  assert(
    (await page.locator('[data-testid="thread-work-context"]').count()) === 1,
    "Existing thread must show read-only context",
  );
  assert(
    (await page
      .getByRole("button", { name: "Choose cloud or computer" })
      .count()) === 0,
    "Existing thread cannot switch its binding",
  );
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.waitForURL(/\/dashboard\/chat\?computer=/);
  await editor().waitFor();
  const localUrl = page.url();
  await editor().fill("本地草稿验收");
  await page.getByRole("button", { name: "Choose cloud or computer" }).click();
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await page.waitForURL(/computer=cloud/);
  await editor().waitFor();
  assert(
    (await editor().innerText()).trim() === "",
    "Cloud must not inherit the local draft",
  );
  await editor().fill("云端草稿验收");
  await page.getByRole("button", { name: "Choose cloud or computer" }).click();
  await page.getByRole("button", { name: /我的 Mac.*Offline/ }).click();
  await page.waitForURL(localUrl);
  assert(
    (await editor().innerText()).trim() === "本地草稿验收",
    "Local draft must survive a mode switch",
  );
  const dimensions = [];
  for (const [width, height] of [
    [960, 640],
    [800, 600],
    [390, 844],
    [320, 720],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(
      (width) => document.documentElement.clientWidth === width,
      width,
    );
    await page
      .getByRole("button", { name: "Choose cloud or computer" })
      .click();
    await page.getByRole("button", { name: "Cloud", exact: true }).waitFor();
    const bounds = await page
      .getByRole("button", { name: "Cloud", exact: true })
      .boundingBox();
    assert(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
      "Mode menu must fit viewport",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Page must not overflow horizontally",
    );
    await page.screenshot({
      animations: "disabled",
      path: `output/playwright/pc-context/title-menu-${width}x${height}.png`,
    });
    dimensions.push({ width, height, menuFits: true });
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 960, height: 640 });
  await editor().fill("");
  return {
    existingBindingReadOnly: true,
    inheritedNewContext: true,
    draftsIsolated: true,
    dimensions,
  };
};
