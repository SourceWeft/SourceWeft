// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { button, click, mountWithIntl, unmountAll } from "@/test/react";

import { McpShowMore } from "./mcp-show-more";

afterEach(async () => {
  await unmountAll();
  document.body.innerHTML = "";
});

function cards(count: number) {
  return Array.from({ length: count }, (_, index) => (
    <a data-card href={`#card-${index + 1}`} key={index}>
      Card {index + 1}
    </a>
  ));
}

describe("McpShowMore", () => {
  it("shows the first five and reveals the rest on 'Show more'", async () => {
    const { container } = await mountWithIntl(
      <McpShowMore initial={5} label="Show more">
        {cards(8)}
      </McpShowMore>,
    );
    expect(container.querySelectorAll("[data-card]")).toHaveLength(5);
    expect(container.textContent).toContain("Card 5");
    expect(container.textContent).not.toContain("Card 6");
    expect(button("Show more").getAttribute("aria-expanded")).toBe("false");
    await click(button("Show more"));
    expect(container.querySelectorAll("[data-card]")).toHaveLength(8);
    expect(container.querySelector("button")).toBeNull();
    // The control is gone: focus lands on the first card it revealed.
    expect(document.activeElement?.textContent).toBe("Card 6");
  });

  it("has no control, and says no total, when everything fits", async () => {
    const { container } = await mountWithIntl(
      <McpShowMore initial={5} label="Show more">
        {cards(5)}
      </McpShowMore>,
    );
    expect(container.querySelectorAll("[data-card]")).toHaveLength(5);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toMatch(/\d+ (?:more|total)/i);
  });

  it("keeps the order of its children", async () => {
    const { container } = await mountWithIntl(
      <McpShowMore initial={2} label="Show more">
        {cards(4)}
      </McpShowMore>,
    );
    expect(
      [...container.querySelectorAll("[data-card]")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Card 1", "Card 2"]);
  });
});
