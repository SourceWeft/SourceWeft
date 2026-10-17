"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
if (!runtime)
  throw new Error("Provisioned SOURCEWEFT_HTML_RUNTIME is required");
const { openDocument, inspect } = require(path.join(runtime, "browser.cjs"));
const [file, directory] = process.argv.slice(2);
if (!file || !directory)
  throw new Error("Usage: node qa-html.cjs report.html qa-directory");
(async () => {
  fs.mkdirSync(directory, { recursive: false });
  fs.writeFileSync(
    path.join(directory, "qa.json"),
    JSON.stringify({ passed: false, status: "running" }),
  );
  const bytes = fs.readFileSync(file);
  const digest =
    "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  const checks = [];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    const session = await openDocument(file, viewport, { bytes });
    try {
      const result = await inspect(session);
      if (result.width > viewport.width + 1)
        result.issues.push("Report overflows the viewport horizontally");
      if (result.height > 12000)
        result.issues.push(
          "Report exceeds the existing 12,000px QA height budget",
        );
      if (
        await session.page
          .locator("button,input,select,textarea,details")
          .count()
      )
        result.issues.push("Report must be a static document");
      const image = path.resolve(directory, `viewport-${viewport.width}.jpg`);
      if (result.height <= 12000)
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
