const assert = require("node:assert/strict");
module.exports = async (page) => {
  await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
  await page.getByRole("button", { name: "Request demo" }).click();
  assert.equal(
    await page.getByRole("status").textContent(),
    "Demo request saved locally.",
  );
  return true;
};
