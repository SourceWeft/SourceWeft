/* global document, innerWidth, innerHeight */
// Run via playwright-cli run-code against the real authenticated E2E thread.
// This only changes the local browser viewport, draft and layout preferences.
// It does not submit a message, fake a native bridge, or mock HTTP responses.
export default async function (page) {
  const editor = page.getByRole("textbox", {
    name: "Message your documents, links, or connected tools...",
  });
  const originalDraft = await editor.innerText();
  const marker = "布局验收草稿：窗口变化后必须保留。";
  const results = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const settle = async (width, height) => {
    await page.setViewportSize({ width, height });
    const mode =
      width >= 1440 ? "wide" : width >= 1120 ? "standard" : "compact";
    await page.waitForFunction(
      ({ width, mode }) => {
        const root = document.querySelector("[data-workspace-layout]");
        return (
          root?.clientWidth === width && root.dataset.workspaceLayout === mode
        );
      },
      { width, mode },
    );
  };
  await settle(1440, 900);
  if (
    await page
      .getByRole("button", { name: "Show conversations", exact: true })
      .count()
  )
    await page
      .getByRole("button", { name: "Show conversations", exact: true })
      .click();
  if (
    await page
      .getByRole("button", { name: "Show sources", exact: true })
      .count()
  )
    await page
      .getByRole("button", { name: "Show sources", exact: true })
      .click();
  await editor.fill(marker);
  for (const [width, height] of [
    [960, 640],
    [1024, 768],
    [1200, 800],
    [1280, 720],
    [1440, 900],
    [800, 533],
    [768, 512],
  ]) {
    await settle(width, height);
    await page.waitForFunction((width) => {
      const sidebar = document.querySelector(
        '[data-testid="conversation-sidebar"]',
      );
      const expected = width >= 1440 ? 312 : width >= 1120 ? 296 : 56;
      return Math.abs(sidebar.getBoundingClientRect().width - expected) < 1;
    }, width);
    const metrics = await page.getByRole("log").evaluate((log) => {
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          right: r.right,
          bottom: r.bottom,
        };
      };
      const logBox = box(log);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        header: box(document.querySelector('[data-testid="chat-header"]')),
        messages: logBox,
        editor: box(document.querySelector("[data-chat-prompt-editor]")),
        submit: box(document.querySelector('button[aria-label="Submit"]')),
        codeBlocks: [
          ...log.querySelectorAll('[data-streamdown="code-block"]'),
        ].map(box),
        inlineCodeFits: [
          ...log.querySelectorAll('[data-streamdown="inline-code"]'),
        ].every((e) =>
          [...e.getClientRects()].every((r) => r.right <= logBox.right + 1),
        ),
      };
    });
    assert(!metrics.pageOverflow, "Page overflow: " + JSON.stringify(metrics));
    assert(
      width < 960 || metrics.header.width >= 640,
      "Chat width is below its budget",
    );
    assert(
      width !== 960 || metrics.messages.height >= 360,
      "Message area is too short at 960×640",
    );
    assert(
      metrics.submit.bottom <= height && metrics.submit.right <= width,
      "Send button is outside the viewport",
    );
    assert(
      metrics.codeBlocks.length > 0,
      "Use a real fixture thread containing a long code output",
    );
    assert(
      metrics.codeBlocks.every(
        (block) => block.width <= metrics.messages.width,
      ),
      "Code block is silently clipped by a wider grid track",
    );
    assert(
      metrics.inlineCodeFits,
      "Long inline paths extend beyond the message viewport",
    );
    assert(
      (await editor.innerText()) === marker,
      "Draft was lost during resize",
    );
    await page
      .getByText("Loading sources...", { exact: true })
      .waitFor({ state: "hidden" });
    await page.screenshot({
      path: `layout-${width}x${height}.png`,
      fullPage: true,
      animations: "disabled",
    });
    results.push(metrics);
  }
  await settle(960, 640);
  await page
    .getByRole("button", { name: "Show conversations", exact: true })
    .click();
  const conversations = page.getByRole("dialog", {
    name: "Conversations",
    exact: true,
  });
  await conversations.waitFor({ state: "visible" });
  await page.screenshot({
    path: "conversations-960x640.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await conversations.waitFor({ state: "hidden" });
  assert(
    await page
      .locator("[data-conversations-toggle]")
      .evaluate((e) => e === document.activeElement),
    "Conversation drawer lost keyboard focus",
  );
  await page.getByRole("button", { name: "Open Hub", exact: true }).click();
  const hub = page.getByRole("dialog", { name: "Hub", exact: true });
  await hub.waitFor({ state: "visible" });
  assert((await conversations.count()) === 0, "Both compact drawers are open");
  await page.screenshot({
    path: "hub-960x640.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await hub.waitFor({ state: "hidden" });
  assert(
    await page
      .locator("[data-hub-toggle]")
      .evaluate((e) => e === document.activeElement),
    "Hub drawer lost keyboard focus",
  );
  await page.getByRole("button", { name: /^Models:/ }).click();
  const models = page.getByRole("dialog", {
    name: "Select model",
    exact: true,
  });
  await models.waitFor({ state: "visible" });
  const modelBounds = await models.boundingBox();
  assert(
    modelBounds.y >= 0 && modelBounds.y + modelBounds.height <= 640,
    "Model dialog is outside the window",
  );
  await page.screenshot({
    path: "models-960x640.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await models.waitFor({ state: "hidden" });
  assert(
    await page.getByTestId("thread-work-context").isVisible(),
    "Existing context is missing",
  );
  assert(
    (await page
      .getByRole("button", { name: "选择云端或电脑", exact: true })
      .count()) === 0,
    "Existing context became editable",
  );
  await page.screenshot({
    path: "work-context-960x640.png",
    fullPage: true,
    animations: "disabled",
  });
  await editor.fill(
    Array.from(
      { length: 30 },
      (_, i) => `第 ${i + 1} 行 / multiline draft`,
    ).join("\n"),
  );
  assert(
    (await editor.boundingBox()).height <= 160,
    "Multiline input exceeds 25% of the short window",
  );
  const send = await page
    .getByRole("button", { name: "Submit", exact: true })
    .boundingBox();
  assert(send.y + send.height <= 640, "Multiline draft hid the send button");
  await page.screenshot({
    path: "multiline-960x640.png",
    fullPage: true,
    animations: "disabled",
  });
  await editor.fill(originalDraft);
  await page.getByRole("button", { name: "LP", exact: true }).click();
  await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Settings center",
    exact: true,
  });
  await settings.waitFor({ state: "visible" });
  for (const [width, height] of [
    [960, 640],
    [640, 426],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(
      ({ width, height }) => {
        const dialog = document.querySelector(
          '[role="dialog"][data-slot="dialog-content"]',
        );
        if (!dialog) return false;
        const r = dialog.getBoundingClientRect();
        return (
          r.width <= width &&
          r.height <= height &&
          r.y >= 0 &&
          r.bottom <= height
        );
      },
      { width, height },
    );
    const bounds = await settings.boundingBox();
    assert(
      bounds.width <= width && bounds.height <= height && bounds.y >= 0,
      "Settings overflow the small viewport: " +
        JSON.stringify({ width, height, bounds }),
    );
    const close = await settings
      .getByRole("button", { name: "Close", exact: true })
      .boundingBox();
    assert(
      close.y >= 0 && close.y + close.height <= height,
      "Settings close button is inaccessible",
    );
    await page.screenshot({
      path: `settings-${width}x${height}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  await settle(960, 640);
  await page
    .getByRole("button", { name: "Show conversations", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Conversations", exact: true })
    .getByRole("button", { name: "New chat", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "New chat", exact: true })
    .waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "选择云端或电脑", exact: true })
    .waitFor({ state: "visible" });
  const newSend = await page
    .getByRole("button", { name: "Submit", exact: true })
    .boundingBox();
  assert(newSend.y + newSend.height <= 640, "New chat send button is clipped");
  for (const [width, height] of [
    [960, 640],
    [800, 533],
    [768, 512],
  ]) {
    await settle(width, height);
    const editorBounds = await editor.boundingBox();
    const headerBounds = await page.getByTestId("chat-header").boundingBox();
    for (const name of [
      "Summarize the selected sources",
      "Compare the main claims across these documents",
      "What changed between these reports?",
      "List the strongest supporting evidence",
    ]) {
      const bounds = await page
        .getByRole("button", { name, exact: true })
        .boundingBox();
      assert(
        bounds.x + bounds.width <= width &&
          bounds.y >= headerBounds.y + headerBounds.height &&
          bounds.y + bounds.height <= editorBounds.y,
        "Suggestion is clipped behind the composer",
      );
    }
    await page.screenshot({
      path: `new-chat-${width}x${height}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await settle(960, 640);
  return {
    status: "passed",
    scope: "real authenticated Web UI; no native or model simulation",
    sizes: results,
    drawers: "mutual exclusion and focus restoration passed",
    existingExecutionTarget: "read-only",
    multiline: "bounded",
    settings: "960×640 and 640×426 passed",
    newChat: "shared header and selectable creation target",
  };
}
