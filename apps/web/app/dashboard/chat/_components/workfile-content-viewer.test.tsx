// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, test } from "vitest";
import { WorkfileContentViewer } from "./workfile-content-viewer";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderViewer(props: {
  contentText: string;
  defaultMode?: "preview" | "source";
  mimeType?: string | null;
  path: string;
}) {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;

  await act(async () => {
    createdRoot.render(createElement(WorkfileContentViewer, props));
  });

  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("WorkfileContentViewer renders code workfiles with CodeBlock", async () => {
  const element = await renderViewer({
    contentText: "console.log('deck');\n",
    path: "/workfiles/ppt/deck.js",
  });

  const codeBlock = element.querySelector('[data-language="javascript"]');
  assert.ok(codeBlock);
  assert.match(element.textContent ?? "", /deck\.js/);
  assert.match(element.textContent ?? "", /console\.log\('deck'\);/);
  assert.ok(
    [...element.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "Copy preview",
    ),
  );
});

test("WorkfileContentViewer renders markdown preview by default with source tab", async () => {
  const element = await renderViewer({
    contentText: "# Deck\n\n```js\nconsole.log('deck');\n```",
    mimeType: "text/markdown",
    path: "/workfiles/ppt/README.md",
  });

  assert.ok(element.querySelector('[role="tab"][data-state="active"]'));
  assert.match(element.textContent ?? "", /Preview/);
  assert.match(element.textContent ?? "", /Source/);
  assert.match(element.textContent ?? "", /Deck/);
});

test("WorkfileContentViewer renders markdown source mode with CodeBlock", async () => {
  const element = await renderViewer({
    contentText: "# Deck\n\n```js\nconsole.log('deck');\n```",
    defaultMode: "source",
    mimeType: "text/markdown",
    path: "/workfiles/ppt/README.md",
  });

  assert.ok(element.querySelector('[data-language="markdown"]'));
  assert.match(element.textContent ?? "", /README\.md/);
});
