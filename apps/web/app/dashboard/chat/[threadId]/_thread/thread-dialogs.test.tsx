// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, test, vi } from "vitest";
import { ThreadDialogs } from "./thread-dialogs";
import type { WorkfileDetail } from "./message-normalizers";
import { mountWithIntl, unmountAll } from "@/test/react";

function workfile(overrides: Partial<WorkfileDetail> = {}): WorkfileDetail {
  return {
    payloadKind: "inline_text",
    contentHash: "a".repeat(64),
    origin: "unknown",
    contentText: "console.log('deck');\n",
    createdAt: "2026-06-20T00:00:00.000Z",
    createdBy: null,
    id: "workfile-1",
    mimeType: "text/markdown",
    path: "/files/deck.js",
    purpose: null,
    sizeBytes: 17 * 1024,
    teamId: "team-1",
    threadId: "thread-1",
    updatedAt: "2026-06-20T00:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

async function renderDialogs(input: {
  previewWorkfile: WorkfileDetail | null;
}) {
  await mountWithIntl(
    createElement(ThreadDialogs, {
      byokCredentials: [],
      byokModelConfig: null,
      byokProviders: [],
      onByokConfigured: vi.fn(),
      onByokModelConfigOpenChange: vi.fn(),
      onByokStateChange: vi.fn(),
      onPreviewSourceOpenChange: vi.fn(),
      onPreviewWorkfileOpenChange: vi.fn(),
      onShortcutsOpenChange: vi.fn(),
      previewCitation: null,
      previewSource: null,
      previewWorkfile: input.previewWorkfile,
      shortcutDefinitions: [],
      shortcutsOpen: false,
      workspaceId: "workspace-1",
    }),
  );

  return document.body;
}

afterEach(unmountAll);

test("ThreadDialogs renders .js workfiles as code even when mime type is markdown", async () => {
  const element = await renderDialogs({
    previewWorkfile: workfile(),
  });

  assert.match(element.textContent ?? "", /deck\.js/);
  assert.match(
    element.textContent ?? "",
    /\/files\/deck\.js · 17 KB · Workfile/,
  );
  assert.ok(element.querySelector('[data-language="javascript"]'));
  assert.match(element.textContent ?? "", /console\.log\('deck'\);/);
  assert.equal(element.querySelector('[role="tab"]'), null);
});
