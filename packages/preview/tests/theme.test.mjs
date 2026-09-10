// @vitest-environment jsdom
import { act, createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ options: [], mounts: 0 }));
vi.mock("@file-viewer/react", () => ({
  default: function MockViewer({ options }) {
    const host = useRef(null);
    observed.options.push(options);
    useEffect(() => {
      observed.mounts++;
      host.current.attachShadow({ mode: "open" });
    }, []);
    return createElement("div", { ref: host, "data-engine": true });
  },
}));
vi.mock("@file-viewer/preset-lite", () => ({ default: [] }));
import { createPreviewView } from "../src/viewer";

let container, root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observed.options = [];
  observed.mounts = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});

it("opens in the host's dark theme with the independent toggle disabled", async () => {
  document.documentElement.className = "dark";
  const View = await createPreviewView("notes.md");
  await act(async () =>
    root.render(
      createElement(View, { file: new File(["# Notes"], "notes.md") }),
    ),
  );
  const options = observed.options.at(-1);
  expect(options.theme).toBe("dark");
  expect(options.toolbar.theme).toBe(false);
  expect(options.toolbar.print).toBe(false);
  expect(options.toolbar.download).toBe(false);
  expect(options.toolbar.exportHtml).toBe(false);
  expect(options.toolbar.position).toBe("top");
  expect(options.ui.surfaceBackground).toBe("var(--background, Canvas)");
  const boundary = container.querySelector("[data-engine]").shadowRoot;
  expect(
    boundary.querySelector("[data-sourceweft-preview-theme]").textContent,
  ).toContain("var(--foreground, CanvasText)");
});

it("follows host theme changes without remounting the viewer or restoring its toggle", async () => {
  document.documentElement.className = "light";
  const View = await createPreviewView("notes.md");
  const file = new File(["# Notes"], "notes.md");
  await act(async () => root.render(createElement(View, { file })));
  expect(observed.options.at(-1).theme).toBe("light");
  await act(async () => {
    document.documentElement.className = "dark";
  });
  expect(observed.options.at(-1).theme).toBe("dark");
  await act(async () => {
    document.documentElement.className = "light";
  });
  expect(observed.options.at(-1).theme).toBe("light");
  expect(observed.mounts).toBe(1);
  expect(
    observed.options.every((options) => options.toolbar.theme === false),
  ).toBe(true);
  expect(
    observed.options.every(
      (options) =>
        options.toolbar.print === false &&
        options.toolbar.download === false &&
        options.toolbar.exportHtml === false,
    ),
  ).toBe(true);
});
