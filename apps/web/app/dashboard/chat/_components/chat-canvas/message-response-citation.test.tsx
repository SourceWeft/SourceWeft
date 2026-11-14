// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { afterEach, test, vi } from "vitest";
import type { CitationRecord } from "./types";

vi.mock("@sourceweft/ui-web/components/ai-elements/message", () => ({
  MessageResponse: (props: {
    children?: string;
    components?: { p?: (input: { children?: ReactNode }) => ReactNode };
  }) =>
    createElement(
      "div",
      null,
      props.components?.p?.({ children: props.children }) ?? props.children,
    ),
}));

import { CitationAwareMessageResponse } from "./message-response";
import { mountWithIntl, unmountAll } from "@/test/react";

afterEach(unmountAll);

function citation(support?: "strong" | "weak"): CitationRecord {
  return {
    citation: "c1",
    sourceId: "source-1",
    sourceTitle: "Annual report",
    documentId: "document-1",
    chunkId: "chunk-1",
    score: 0.9,
    excerpt: "Excerpt text",
    ...(support ? { support } : {}),
  };
}

async function chip(support?: "strong" | "weak") {
  await mountWithIntl(
    <CitationAwareMessageResponse citations={[citation(support)]}>
      {"Revenue grew [citation:c1]."}
    </CitationAwareMessageResponse>,
  );
  const button = document.body.querySelector("button");
  console.log("HTML", document.body.innerHTML);
  assert.ok(button);
  return button;
}

test("a citation whose passage was not located is marked on the chip", async () => {
  const button = await chip("weak");
  assert.ok(button.className.includes("ring-amber"));
  assert.ok(button.title.includes("Excerpt text"));
  assert.ok(button.title.includes("not located"));
});

test("supported and unchecked citations keep the plain chip", async () => {
  for (const support of ["strong", undefined] as const) {
    await unmountAll();
    const button = await chip(support);
    assert.equal(button.className.includes("ring-amber"), false);
    assert.equal(button.title, "Excerpt text");
  }
});
