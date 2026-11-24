// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ResearchEntry } from "./research-entry";
import { click, mountWithIntl, unmountAll } from "@/test/react";

afterEach(unmountAll);

test("the Research entry is hidden when the web provider is unavailable", async () => {
  await mountWithIntl(
    createElement(ResearchEntry, {
      available: false,
      disabled: false,
      onOpen: vi.fn(),
    }),
  );
  expect(document.body.textContent).not.toContain("Research");
  expect(document.body.querySelector("button")).toBeNull();
});

test("the Research entry opens the dialog when available", async () => {
  const onOpen = vi.fn();
  await mountWithIntl(
    createElement(ResearchEntry, { available: true, disabled: false, onOpen }),
  );
  await click(document.body.querySelector("button")!);
  expect(onOpen).toHaveBeenCalled();
});
