// Run after Add image and playwright-cli upload fixtures/layout-{1..8}.png.
// These fixtures stay in the local draft; no message is submitted.
export default async function (page) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const images = page.getByRole("button", {
    name: /^8 images ·/,
    exact: true,
  });
  await images.waitFor({ state: "visible" });
  await page.mouse.move(950, 8);
  await page
    .locator('[data-slot="hover-card-content"]')
    .waitFor({ state: "hidden" });
  if ((await images.getAttribute("aria-expanded")) === "true")
    await images.click();
  await page.mouse.move(950, 8);
  await page
    .locator('[data-slot="hover-card-content"]')
    .waitFor({ state: "hidden" });
  await page.screenshot({
    path: "attachments-collapsed-960x640.png",
    fullPage: true,
    animations: "disabled",
  });
  await images.click();
  await page.mouse.move(950, 8);
  await page
    .locator('[data-slot="hover-card-content"]')
    .waitFor({ state: "hidden" });
  await page.getByText("layout-6.png", { exact: true }).hover();
  const preview = page.locator('[data-slot="hover-card-content"]');
  await preview.waitFor({ state: "visible" });
  const previewBounds = await preview.boundingBox();
  assert(
    previewBounds.x >= 0 &&
      previewBounds.y >= 0 &&
      previewBounds.x + previewBounds.width <= 960 &&
      previewBounds.y + previewBounds.height <= 640,
    "Image preview overflows the small window",
  );
  await images.click();
  assert(
    (await images.getAttribute("aria-expanded")) === "false",
    "Hover preview blocked the collapse button",
  );
  await images.click();
  await page.mouse.move(950, 8);
  await preview.waitFor({ state: "hidden" });
  const imageSend = await page
    .getByRole("button", { name: "Submit", exact: true })
    .boundingBox();
  assert(
    imageSend.y + imageSend.height <= 640,
    "Attachments hid the send button",
  );
  await page.screenshot({
    path: "attachments-960x640.png",
    fullPage: true,
    animations: "disabled",
  });
  while (
    await page
      .getByRole("button", { name: /^Remove layout-\d+\.png$/, exact: true })
      .count()
  ) {
    await page
      .getByRole("button", { name: /^Remove layout-\d+\.png$/, exact: true })
      .first()
      .click();
  }
  if (await page.getByRole("button", { name: /images ·/ }).count())
    throw new Error("Attachment cleanup is incomplete");
  return {
    status: "passed",
    images: 8,
    previewBounds,
    collapseWhilePreviewVisible: "passed",
    submitted: false,
    sendButton: "visible",
    draftAttachmentsRemoved: true,
  };
}
