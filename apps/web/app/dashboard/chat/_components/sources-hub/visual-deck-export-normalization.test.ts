// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  normalizeVisualDeckSlidesForExport,
  visualDeckSlideBackgroundColor,
} from "./visual-deck-export-normalization";

function mountDeck(markup: string, css = "") {
  document.head.innerHTML = css ? `<style>${css}</style>` : "";
  document.body.className = "sw-export";
  document.body.innerHTML = markup;
  return Array.from(
    document.querySelectorAll<HTMLElement>(".sw-slide"),
  );
}

function firstSlide(slides: HTMLElement[]) {
  const slide = slides[0];
  if (!slide) {
    throw new Error("Expected the mounted deck to include a slide.");
  }
  return slide;
}

function resolvePseudoStyles(
  slide: HTMLElement,
  pseudoStyles: Partial<
    Record<"::after" | "::before", Partial<CSSStyleDeclaration>>
  >,
) {
  const view = slide.ownerDocument.defaultView;
  if (!view) {
    throw new Error("Expected slide to have an owner window.");
  }
  const originalGetComputedStyle = view.getComputedStyle.bind(view);
  return (element: HTMLElement, pseudoElement: "::after" | "::before") => {
    if (element !== slide || !(pseudoElement in pseudoStyles)) {
      return null;
    }
    return {
      ...originalGetComputedStyle(element),
      backgroundColor: "transparent",
      backgroundImage: "none",
      bottom: "auto",
      content: '""',
      height: "auto",
      left: "auto",
      right: "auto",
      top: "auto",
      width: "auto",
      ...pseudoStyles[pseudoElement],
    } as CSSStyleDeclaration;
  };
}

describe("normalizeVisualDeckSlidesForExport", () => {
  it("preserves a slide's own background to stay close to the live preview", () => {
    const slide = firstSlide(
      mountDeck(
        '<section class="sw-slide"><h1>Title</h1></section>',
        `
.sw-slide {
  background: linear-gradient(135deg, rgb(10, 20, 30), rgb(40, 50, 60));
  position: static;
}
`,
      ),
    );

    normalizeVisualDeckSlidesForExport([slide], { resolvePseudoStyle: () => null });

    const baseLayer = slide.querySelector<HTMLElement>(
      ':scope > [data-sw-export-bg="base"]',
    );
    expect(baseLayer).toBeNull();
    expect(getComputedStyle(slide).backgroundImage).toContain("linear-gradient");
    expect(slide.style.position).toBe("");
    expect(slide.style.isolation).toBe("");
  });

  it("uses a parent background when the slide itself is transparent", () => {
    const slide = firstSlide(
      mountDeck(
        `
<main class="deck-shell">
  <section class="sw-slide"><div class="content">Body</div></section>
</main>
`,
        `
.deck-shell { background: rgb(17, 34, 51); }
.sw-slide { background: transparent; }
`,
      ),
    );

    normalizeVisualDeckSlidesForExport([slide], { resolvePseudoStyle: () => null });

    const baseLayer = slide.querySelector<HTMLElement>(
      ':scope > [data-sw-export-bg="base"]',
    );
    expect(baseLayer).toBeTruthy();
    expect(getComputedStyle(baseLayer as HTMLElement).backgroundColor).toBe(
      "rgb(17, 34, 51)",
    );
    expect(visualDeckSlideBackgroundColor(slide)).toBe("rgb(17, 34, 51)");
  });

  it("does not materialize pseudo backgrounds by default", () => {
    const slide = firstSlide(
      mountDeck(
        '<section class="sw-slide"><div>Body</div></section>',
        `
.sw-slide { background: rgb(255, 255, 255); position: relative; }
`,
      ),
    );
    const resolvePseudoStyle = resolvePseudoStyles(slide, {
      "::before": {
        backgroundImage: "linear-gradient(90deg, red, blue)",
        inset: "0",
      },
    });

    normalizeVisualDeckSlidesForExport([slide], { resolvePseudoStyle });

    expect(
      slide.querySelector(':scope > [data-sw-export-bg="before"]'),
    ).toBeNull();
    expect(slide.dataset.swExportHasBeforeBg).toBeUndefined();
  });

  it("suppresses slide before pseudo overlays by default", () => {
    const slide = firstSlide(
      mountDeck(
        '<section class="sw-slide"><div>Body</div></section>',
        ".sw-slide { background: rgb(255, 255, 255); position: relative; }",
      ),
    );

    normalizeVisualDeckSlidesForExport([slide], {
      resolvePseudoStyle: () => null,
    });

    expect(
      document.body.classList.contains("sw-export-suppress-slide-before"),
    ).toBe(true);
    expect(slide.dataset.swExportSuppressBefore).toBe("true");
    expect(
      document
        .getElementById("sourceweft-visual-deck-export-normalization")
        ?.textContent?.includes("sw-export-suppress-slide-before"),
    ).toBe(true);
  });

  it("can leave slide before pseudo overlays enabled for compatibility exports", () => {
    const slide = firstSlide(
      mountDeck(
        '<section class="sw-slide"><div>Body</div></section>',
        ".sw-slide { background: rgb(255, 255, 255); position: relative; }",
      ),
    );

    normalizeVisualDeckSlidesForExport([slide], {
      resolvePseudoStyle: () => null,
      suppressSlideBeforePseudo: false,
    });

    expect(
      document.body.classList.contains("sw-export-suppress-slide-before"),
    ).toBe(false);
    expect(slide.dataset.swExportSuppressBefore).toBeUndefined();
  });

  it("can materialize pseudo backgrounds for compatibility exports", () => {
    const slide = firstSlide(
      mountDeck(
        '<section class="sw-slide"><div>Body</div></section>',
        `
.sw-slide { background: rgb(255, 255, 255); position: relative; }
`,
      ),
    );
    const resolvePseudoStyle = resolvePseudoStyles(slide, {
      "::after": {
        backgroundColor: "rgb(255, 0, 0)",
        bottom: "54px",
        height: "2px",
        right: "64px",
        width: "280px",
      },
      "::before": {
        backgroundImage: "linear-gradient(90deg, red, blue)",
        inset: "0",
      },
    });

    normalizeVisualDeckSlidesForExport([slide], {
      materializePseudoElements: true,
      resolvePseudoStyle,
    });

    const beforeLayer = slide.querySelector<HTMLElement>(
      ':scope > [data-sw-export-bg="before"]',
    );
    const afterLayer = slide.querySelector<HTMLElement>(
      ':scope > [data-sw-export-bg="after"]',
    );
    expect(beforeLayer?.style.backgroundImage).toContain("linear-gradient");
    expect(afterLayer?.style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(afterLayer?.style.right).toBe("64px");
    expect(afterLayer?.style.bottom).toBe("54px");
    expect(slide.dataset.swExportHasBeforeBg).toBe("true");
    expect(slide.dataset.swExportHasAfterBg).toBe("true");
    expect(
      document.body.classList.contains("sw-export-suppress-slide-before"),
    ).toBe(false);
    expect(
      document.getElementById("sourceweft-visual-deck-export-normalization"),
    ).toBeTruthy();
  });

  it("removes existing export layers before normalizing again", () => {
    const slide = firstSlide(
      mountDeck(
        `
<section class="sw-slide">
  <div data-sw-export-bg="base"></div>
  <p>Body</p>
</section>
`,
        "body { background: rgb(1, 2, 3); } .sw-slide { background: transparent; }",
      ),
    );

    normalizeVisualDeckSlidesForExport([slide], { resolvePseudoStyle: () => null });
    normalizeVisualDeckSlidesForExport([slide], { resolvePseudoStyle: () => null });

    expect(
      slide.querySelectorAll(':scope > [data-sw-export-bg="base"]'),
    ).toHaveLength(1);
  });
});
