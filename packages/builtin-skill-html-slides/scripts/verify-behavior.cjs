"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { spawnSync } = require("node:child_process");
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME,
  H = require(path.join(runtime, "bundle.cjs")),
  { openDocument, inspect } = require(path.join(runtime, "browser.cjs"));
const out = path.resolve(process.argv[2] || "output/html-behavior");
fs.mkdirSync(out, { recursive: true });
const source = path.join(out, "source.html");
fs.writeFileSync(
  source,
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><section data-slide-id="intro"><p class="kicker">Independent presentation</p><h1 class="h1">离线演示</h1><p class="fragment">第一条证据</p><p class="fragment">第二条证据</p></section><section data-slide-id="effect"><h2 class="h2">持续运行的效果</h2><div data-fx="starfield" data-text-role="decoration" style="height:380px;width:100%;background:#102030"></div></section><section data-slide-id="summary"><h2 class="h2">原始第三页</h2><p>保留稳定页面 ID。</p></section></body></html>',
);
function build(input, output, ratio) {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, "build.cjs"), input, output, "--ratio=" + ratio],
    {
      env: process.env,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}
(async () => {
  const results = [];
  for (const ratio of ["16:9", "4:3"]) {
    const file = path.join(
      out,
      ratio === "16:9" ? "wide.html" : "classic.html",
    );
    build(source, file, ratio);
    for (const engine of ["chromium", "firefox", "webkit"]) {
      const session = await openDocument(
        file,
        { width: ratio === "16:9" ? 1280 : 960, height: 720 },
        { engine },
      );
      try {
        await session.page.evaluate(
          () => window.__sourceweftPresentationQA.ready,
        );
        await session.page.keyboard.press("ArrowRight");
        assert.equal(
          await session.page.evaluate(
            () => window.__sourceweftPresentationQA.deck.getIndices().h,
          ),
          0,
        );
        assert.ok(
          (await session.page.evaluate(
            () => window.__sourceweftPresentationQA.deck.getIndices().f,
          )) >= 0,
        );
        await session.page.evaluate(() =>
          window.__sourceweftPresentationQA.capture(1, 1000),
        );
        const check = await inspect(session, "section.present", {
          minimumBodyFont: 24,
        });
        assert.deepEqual(check.issues, []);
        const stable = await session.page.evaluate(async () => {
          const qa = window.__sourceweftPresentationQA;
          await qa.resume();
          qa.deck.slide(1);
          const before = qa.metrics();
          qa.deck.toggleOverview(true);
          const stopped = qa.metrics();
          qa.deck.toggleOverview(false);
          const after = qa.metrics();
          return { before, stopped, after };
        });
        assert.equal(stable.stopped.loops, 0);
        assert.equal(stable.before.scopes, stable.after.scopes);
        await session.page.screenshot({
          path: path.join(out, engine + "-" + ratio.replace(":", "-") + ".jpg"),
          type: "jpeg",
          quality: 90,
        });
        results.push({
          engine,
          version: session.browser.version(),
          ratio,
          networkMode: session.networkMode,
          passed: true,
        });
      } finally {
        await session.close();
      }
      const local = await openDocument(
        file,
        { width: ratio === "16:9" ? 1280 : 960, height: 720 },
        { engine, standalone: true },
      );
      try {
        await local.page.evaluate(() =>
          window.__sourceweftPresentationQA.capture(0, 2500),
        );
        assert.deepEqual(
          (await inspect(local, "section.present", { minimumBodyFont: 24 }))
            .issues,
          [],
        );
        results.at(-1).standaloneChecked = true;
        results.at(-1).standaloneNetworkMode = local.networkMode;
      } finally {
        await local.close();
      }
    }
  }
  const original = path.join(out, "wide.html"),
    doc = H.parse(fs.readFileSync(original, "utf8"));
  let page;
  H.walk(doc, (n) => {
    if (H.attr(n, "data-slide-id") === "summary") page = n;
  });
  const heading = page.childNodes.find((n) => n.tagName === "h2");
  heading.childNodes = [
    { nodeName: "#text", value: "修改后的第三页", parentNode: heading },
  ];
  const revisedSource = path.join(out, "revision-source.html");
  fs.writeFileSync(revisedSource, H.serialize(doc));
  const revised = path.join(out, "revised.html");
  build(revisedSource, revised, "16:9");
  const session = await openDocument(revised, { width: 1280, height: 720 });
  try {
    await session.page.evaluate(() =>
      window.__sourceweftPresentationQA.capture(2, 2500),
    );
    assert.equal(
      await session.page.locator("section.present h2").textContent(),
      "修改后的第三页",
    );
    assert.deepEqual(
      await session.page.evaluate(() =>
        window.__sourceweftPresentationQA.slides.map((s) => s.dataset.slideId),
      ),
      ["intro", "effect", "summary"],
    );
    assert.deepEqual(
      (await inspect(session, "section.present", { minimumBodyFont: 24 }))
        .issues,
      [],
    );
    results.push({ revision: "page-3", passed: true });
  } finally {
    await session.close();
  }
  fs.writeFileSync(
    path.join(out, "summary.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
