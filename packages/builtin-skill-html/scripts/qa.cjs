"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
if (!runtime) throw new Error("SOURCEWEFT_HTML_RUNTIME is required");
const { openDocument, inspect } = require(path.join(runtime, "browser.cjs"));
const [file, directory, interactionScript] = process.argv.slice(2);
if (!file || !directory)
  throw new Error(
    "Usage: qa.cjs index.html qa-directory [interaction-checks.cjs]",
  );
(async () => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "qa.json"),
    JSON.stringify({ passed: false, status: "running" }),
  );
  const bytes = fs.readFileSync(file),
    digest =
      "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  const viewports = [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ],
    checks = [];
  for (const viewport of viewports) {
    const session = await openDocument(file, viewport, { bytes });
    try {
      const interactive = await session.page
        .locator("button,input,select,textarea,details")
        .count();
      if (interactive && !interactionScript)
        throw new Error(
          "HTML_INTERACTION_TEST_REQUIRED: provide a local module exporting async function(page) with assertions for the page controls",
        );
      if (interactionScript) {
        const result = await require(path.resolve(interactionScript))(
          session.page,
        );
        if (result !== true)
          throw new Error(
            "Interaction checks must complete their assertions and return true",
          );
      }
      await session.page.evaluate(async () => {
        for (
          let y = 0;
          y < Math.min(document.documentElement.scrollHeight, 12000);
          y += innerHeight
        ) {
          scrollTo(0, y);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        scrollTo(0, 0);
        await Promise.all(
          [...document.images].map((image) => image.decode().catch(() => {})),
        );
      });
      const result = await inspect(session);
      if (result.height > 12_000)
        result.issues.push(
          "Page exceeds the bounded 12,000px screenshot budget; split the report into sections",
        );
      const image = path.resolve(directory, `viewport-${viewport.width}.jpg`);
      if (result.height <= 12_000)
        await session.page.screenshot({
          path: image,
          type: "jpeg",
          quality: 90,
          fullPage: true,
        });
      checks.push({ viewport, image, ...result });
    } finally {
      await session.close();
    }
  }
  const unchanged =
    digest ===
    "sha256:" +
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const report = {
    passed: unchanged && checks.every((c) => !c.issues.length),
    contentDigest: digest,
    unchanged,
    checks,
    visualReview: "not_run",
  };
  fs.writeFileSync(
    path.join(directory, "qa.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
