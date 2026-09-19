/* global document, innerWidth */
// Run with playwright-cli run-code in an authenticated session against real services.
// Start on an existing local conversation; this checks UI, not native command execution.
export default async (page) => {
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const base = await page.evaluate(() => location.origin);
  const localUrl = page.url();
  assert(
    /\/dashboard\/chat\/[^?]+/.test(localUrl),
    "Start on a persisted local conversation",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const text = document.querySelector(
      '[data-testid="thread-work-context"]',
    )?.textContent;
    return (
      text && !text.includes("Connecting") && !text.includes("unavailable")
    );
  });
  await page.getByRole("button", { name: "Conversation details" }).click();
  const details = await page.getByRole("dialog").innerText();
  assert(
    details.includes("This conversation uses a fixed computer"),
    "Existing local binding must remain immutable",
  );
  assert(
    (await page
      .getByRole("button", { name: "Choose cloud or computer" })
      .count()) === 0,
    "Existing conversations cannot switch computers",
  );
  await page.keyboard.press("Escape");
  const localLabel = await page.getByTestId("thread-work-context").innerText();
  await page.goto(`${base}/dashboard/chat?computer=cloud`);
  const editor = () =>
    page
      .getByRole("textbox", {
        name: "Message your documents, links, or connected tools...",
      })
      .filter({ visible: true });
  const selector = () =>
    page.getByRole("button", { name: "Choose cloud or computer" });
  await editor().waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Choose cloud or computer"]')
      ?.textContent.includes("Cloud"),
  );
  await editor().fill("侧栏缩放验收草稿");
  const dimensions = [];
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [1120, 720],
    [960, 640],
    [800, 600],
    [390, 844],
    [320, 720],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(
      ({ width, headerHeight }) =>
        document.documentElement.clientWidth === width &&
        document
          .querySelector('[data-testid="chat-header"]')
          ?.getBoundingClientRect().height === headerHeight,
      { width, headerHeight: width >= 640 ? 56 : 48 },
    );
    const header = await page.getByTestId("chat-header").boundingBox();
    const title = await page
      .getByTestId("chat-header")
      .getByRole("heading")
      .boundingBox();
    const target = await selector().boundingBox();
    assert(
      title.y >= header.y && title.y + title.height <= header.y + header.height,
      "Title must fit inside header",
    );
    assert(
      target.y >= header.y &&
        target.y + target.height <= header.y + header.height,
      "Computer control must fit inside header",
    );
    assert(
      title.width > 20 &&
        target.width > 20 &&
        title.x + title.width <= header.x + header.width,
      "Title and computer must remain visible",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Page must not overflow",
    );
    assert(
      (await editor().innerText()).includes("侧栏缩放验收草稿"),
      "Resizing must preserve draft",
    );
    assert(
      await selector()
        .locator("span")
        .first()
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "Short computer labels must not be unnecessarily truncated",
    );
    await page.mouse.move(width - 4, height / 2);
    await page.screenshot({
      path: `output/playwright/pc-context/sidebar-cloud-${width}x${height}.png`,
      animations: "disabled",
    });
    await selector().click();
    const menu = await page.getByRole("dialog").boundingBox();
    assert(
      menu.x >= 0 &&
        menu.x + menu.width <= width + 1 &&
        menu.y + menu.height <= height + 1,
      "Computer menu must fit viewport",
    );
    await page.keyboard.press("Escape");
    if (width < 768) {
      assert(
        (await page.getByTestId("conversation-sidebar").count()) === 0,
        "Collapsed sidebar must leave no rail",
      );
      await page.locator("[data-conversations-toggle]").click();
      const drawer = page.getByRole("dialog", {
        name: "Navigation and conversations",
      });
      await drawer.waitFor();
      const bounds = await drawer.boundingBox();
      assert(bounds.width < width, "Drawer must leave room to dismiss");
      await drawer
        .getByRole("button", { name: "Account and settings" })
        .waitFor();
      await page.screenshot({
        path: `output/playwright/pc-context/sidebar-drawer-${width}x${height}.png`,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() =>
        document.activeElement?.hasAttribute("data-conversations-toggle"),
      );
    } else {
      assert(
        (await page.getByTestId("conversation-sidebar").boundingBox()).width ===
          248,
        "Unified sidebar width",
      );
    }
    dimensions.push({
      width,
      height,
      headerHeight: header.height,
      menuFits: true,
      draftPreserved: true,
    });
  }
  // Explicit collapse survives resizing; non-chat pages retain a way back to navigation.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("conversation-sidebar").waitFor();
  await page.locator("[data-conversations-toggle]").click();
  await page.setViewportSize({ width: 960, height: 640 });
  await page.setViewportSize({ width: 1280, height: 800 });
  assert(
    (await page.getByTestId("conversation-sidebar").count()) === 0,
    "Explicit collapse preference must persist",
  );
  await page.locator("[data-conversations-toggle]").click();
  await page.getByRole("link", { name: "Skills", exact: true }).click();
  await page.waitForURL(/\/dashboard\/skills/);
  await page
    .getByTestId("conversation-sidebar")
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await page
    .getByTestId("navigation-rail")
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await page
    .getByTestId("conversation-sidebar")
    .getByRole("button", { name: "New chat", exact: true })
    .waitFor();
  await page.goto(localUrl);
  await page.getByTestId("thread-work-context").waitFor();
  await page.waitForFunction(
    (label) =>
      document.querySelector('[data-testid="thread-work-context"]')
        ?.textContent === label,
    localLabel,
  );
  assert(
    (await selector().count()) === 0,
    "Navigation and layout changes must not retarget the existing conversation",
  );
  return {
    dimensions,
    existingBindingReadOnly: true,
    localDetails: details,
    nonChatNavigation: true,
    explicitPreferencePreserved: true,
  };
};
