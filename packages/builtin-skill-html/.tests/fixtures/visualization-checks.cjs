const assert = require("node:assert/strict");
module.exports = async (page) => {
  await page.getByRole("slider", { name: "Coverage" }).focus();
  await page.keyboard.press("End");
  assert.equal(await page.locator("#cost").textContent(), "1200");
  assert.equal(
    await page.locator("#scenario-bar").getAttribute("height"),
    "200",
  );
  await page.getByRole("button", { name: "Reset" }).click();
  assert.equal(await page.locator("#cost").textContent(), "480");
  return true;
};
