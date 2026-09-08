# Final-file quality checks

Check the actual bundled file at desktop, tablet and mobile viewports. Confirm headings, text, tables, charts, image loading and long-page tails. Review screenshots with the configured vision model. Source inspection alone cannot establish visual quality.

For interactions, write a small conventional Playwright module next to the page. Example:

```js
const assert = require("node:assert/strict");
module.exports = async (page) => {
  await page.getByRole("button", { name: "Increment" }).click();
  assert.equal(await page.locator("#count").textContent(), "1");
  return true;
};
```

Exercise every requested control and its expected result; don't replace assertions with unconditional success. Network attempts, runtime exceptions, missing glyphs, unintended overflow and major visual issues must be fixed. After changes, rebuild and use the new final digest. Missing QA tools or a failed vision call are explicit incomplete results.
