// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { stripExecutableVisualDeckHtmlForExport } from "./visual-deck-export-html";

describe("stripExecutableVisualDeckHtmlForExport", () => {
  it("removes executable script surfaces while preserving deck content", () => {
    const sanitized = stripExecutableVisualDeckHtmlForExport(`<!doctype html>
<html data-sourceweft-deck="visual_html" data-sourceweft-fonts="{&quot;fonts&quot;:[]}">
<head>
  <style>.sw-slide::before { content: ""; background: red; }</style>
  <script>window.evil = true;</script>
</head>
<body onload="evil()">
  <main class="deck-viewport">
    <a class="link" href="javascript:evil()" style="color: red">bad</a>
    <section class="sw-slide" onclick="evil()" data-kind="quote">
      <img src="javascript:evil()" alt="unsafe" />
      <h1>Slide</h1>
    </section>
  </main>
</body>
</html>`);
    const doc = new DOMParser().parseFromString(sanitized, "text/html");

    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector(".sw-slide")).toBeTruthy();
    expect(doc.querySelector("style")?.textContent).toContain(".sw-slide::before");
    expect(doc.documentElement.dataset.sourceweftFonts).toBe('{"fonts":[]}');
    expect(doc.body.getAttribute("onload")).toBeNull();
    expect(doc.querySelector(".sw-slide")?.getAttribute("onclick")).toBeNull();
    expect(doc.querySelector(".link")?.getAttribute("href")).toBeNull();
    expect(doc.querySelector("img")?.getAttribute("src")).toBeNull();
  });

  it("removes unsafe inline style urls", () => {
    const sanitized = stripExecutableVisualDeckHtmlForExport(
      '<section class="sw-slide" style="background-image: url(javascript:evil())">Slide</section>',
    );
    const doc = new DOMParser().parseFromString(sanitized, "text/html");

    expect(doc.querySelector(".sw-slide")?.getAttribute("style")).toBeNull();
  });

  it("preserves v3 custom visual scene metadata for export", () => {
    const sanitized = stripExecutableVisualDeckHtmlForExport(`<!doctype html>
<html
  data-sourceweft-deck="visual_html"
  data-sourceweft-family="education"
  data-sourceweft-density="airy"
  data-sourceweft-geometry="soft"
  data-sourceweft-chrome="lecture"
  data-sourceweft-illustration="handdrawn"
  data-sourceweft-visual-system="{&quot;version&quot;:3,&quot;family&quot;:&quot;education&quot;,&quot;coverTreatment&quot;:&quot;notebook-map&quot;,&quot;compiledVisualScenes&quot;:[{&quot;sceneId&quot;:&quot;visual-scene-1&quot;}]}"
>
<body>
  <main class="deck-viewport">
    <div class="deck-shell" data-aspect-ratio="16:9">
      <section
        class="sw-slide visual-layout-education-step-board cover-education cover-notebook-map"
        data-sourceweft-family="education"
        data-layout="education-step-board"
        data-macro-layout="step-board"
        data-visual-role="cover"
        data-kind="title"
        data-image-slot="diagram"
        data-cover-treatment="notebook-map"
        data-sourceweft-scene-id="visual-scene-1"
      >
        <div class="cover-scene" data-sourceweft-scene="visual-scene-1">
          <h1
            class="scene-node scene-text-slot"
            data-node-kind="text-slot"
            data-node-role="title"
          >四步把复杂概念讲清楚</h1>
          <div class="scene-node scene-panel" data-node-kind="panel"></div>
        </div>
      </section>
    </div>
  </main>
</body>
</html>`);
    const doc = new DOMParser().parseFromString(sanitized, "text/html");
    const slide = doc.querySelector<HTMLElement>(".sw-slide");

    expect(doc.documentElement.dataset.sourceweftFamily).toBe("education");
    expect(doc.documentElement.dataset.sourceweftVisualSystem).toContain(
      '"version":3',
    );
    expect(slide?.dataset.layout).toBe("education-step-board");
    expect(slide?.dataset.macroLayout).toBe("step-board");
    expect(slide?.dataset.visualRole).toBe("cover");
    expect(slide?.dataset.imageSlot).toBe("diagram");
    expect(slide?.dataset.coverTreatment).toBe("notebook-map");
    expect(slide?.dataset.sourceweftSceneId).toBe("visual-scene-1");
    expect(
      doc.querySelector<HTMLElement>(".cover-scene")?.dataset.sourceweftScene,
    ).toBe("visual-scene-1");
    expect(
      doc.querySelector<HTMLElement>(".scene-text-slot")?.dataset.nodeKind,
    ).toBe("text-slot");
  });
});
