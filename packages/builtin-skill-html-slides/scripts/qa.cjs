"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
if (!runtime) throw new Error("SOURCEWEFT_HTML_RUNTIME is required");
const { openDocument, inspect } = require(path.join(runtime, "browser.cjs"));
const [file, directory] = process.argv.slice(2);
if (!file || !directory)
  throw new Error("Usage: qa.cjs index.html qa-directory");
(async () => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "qa.json"),
    JSON.stringify({ passed: false, status: "running" }),
  );
  const bytes = fs.readFileSync(file);
  const H = require(path.join(runtime, "bundle.cjs"));
  const doc = H.parse(bytes.toString("utf8"));
  let config;
  H.walk(doc, (n) => {
    if (H.attr(n, "id") === "sourceweft-deck-config")
      config = JSON.parse(
        (n.childNodes || []).map((c) => c.value || "").join(""),
      );
  });
  if (!config || ![960, 1280].includes(config.width) || config.height !== 720)
    throw new Error("Invalid presentation canvas");
  const viewport = { width: config.width, height: config.height };
  const snapshot = path.resolve(directory, ".independent-snapshot.html");
  fs.writeFileSync(snapshot, bytes);
  const session = await openDocument(file, viewport, { bytes });
  const pages = [];
  const issues = [];
  try {
    await session.page.evaluate(() => window.__sourceweftPresentationQA.ready);
    const count = await session.page.evaluate(
      () => window.__sourceweftPresentationQA.slides.length,
    );
    for (let i = 0; i < count; i++) {
      await session.page.evaluate(() => {
        window.__sourceweftCanvasFonts = [];
        window.__sourceweftCanvasText.clear();
      });
      await session.page.evaluate((i) => {
        const qa = window.__sourceweftPresentationQA;
        return qa.capture(i, Number(qa.slides[i].dataset.captureMs || 2500));
      }, i);
      const hover = session.page.locator("section.present [data-qa-hover]");
      if (await hover.count()) await hover.first().hover();
      const animationIssues = await session.page.evaluate(() => {
        const slide = window.__sourceweftPresentationQA.deck.getCurrentSlide(),
          issues = [];
        for (const el of slide.querySelectorAll("[data-anim]")) {
          if (
            !el.getBoundingClientRect().width ||
            getComputedStyle(el).visibility === "hidden"
          )
            continue;
          const name = el.dataset.anim;
          if (name === "counter-up") continue;
          if (name === "parallax-tilt") {
            if (
              el.hasAttribute("data-qa-hover") &&
              getComputedStyle(el).transform === "none"
            )
              issues.push("Hover animation did not transform its element");
          } else if (!el.getAnimations({ subtree: true }).length)
            issues.push("Animation has no matching animated elements: " + name);
        }
        return issues;
      });
      const check = await inspect(session, "section.present", {
        minimumBodyFont: 24,
      });
      check.issues.push(...animationIssues);
      const image = path.resolve(
        directory,
        `slide-${String(i + 1).padStart(2, "0")}.jpg`,
      );
      await session.page.screenshot({ path: image, type: "jpeg", quality: 90 });
      pages.push({ index: i, image, issues: check.issues });
      issues.push(...check.issues.map((x) => `Page ${i + 1}: ${x}`));
    }
    await session.page.evaluate(() =>
      window.__sourceweftPresentationQA.resume(),
    );
    const cleanup = await session.page.evaluate(async () => {
      const qa = window.__sourceweftPresentationQA;
      qa.deck.slide(0);
      const before = qa.metrics();
      for (let i = 0; i < 5; i++) {
        qa.deck.slide(qa.slides.length - 1);
        qa.deck.slide(0);
      }
      const after = qa.metrics();
      await qa.dispose();
      return { before, after, disposed: qa.metrics() };
    });
    if (JSON.stringify(cleanup.before) !== JSON.stringify(cleanup.after))
      issues.push("FX lifecycle resources grow after repeated navigation");
    if (Object.values(cleanup.disposed).some((n) => n !== 0))
      issues.push("FX resources remain after disposal");
    const standalone = await openDocument(snapshot, viewport, {
      standalone: true,
      bytes,
    });
    try {
      await standalone.page.evaluate(() =>
        window.__sourceweftPresentationQA.capture(0, 2500),
      );
      const check = await inspect(standalone, "section.present", {
        minimumBodyFont: 24,
      });
      issues.push(...check.issues.map((x) => "Independent file: " + x));
    } finally {
      await standalone.close();
    }
    if (
      "sha256:" +
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex") !==
      session.contentDigest
    )
      issues.push("HTML changed during QA");
    const report = {
      passed: issues.length === 0,
      contentDigest: session.contentDigest,
      pages,
      issues,
      cleanup,
      standaloneChecked: true,
      visualReview: "not_run",
    };
    fs.writeFileSync(
      path.join(directory, "qa.json"),
      JSON.stringify(report, null, 2),
    );
    fs.writeFileSync(
      path.join(directory, "attachments.json"),
      JSON.stringify(
        pages.map((p) => ({
          fileName: path.basename(p.image),
          contentType: "image/jpeg",
          role: "asset",
          access: "artifact",
          source: { kind: "sandbox_path", path: p.image },
        })),
        null,
        2,
      ),
    );
    console.log(JSON.stringify(report, null, 2));
    if (issues.length) process.exitCode = 1;
  } finally {
    await session.close();
    fs.rmSync(snapshot, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
