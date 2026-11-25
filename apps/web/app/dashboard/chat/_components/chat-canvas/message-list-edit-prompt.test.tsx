// @vitest-environment jsdom
import assert from "node:assert/strict";
import { type PropsWithChildren } from "react";
import { afterEach, test, vi } from "vitest";
import { mountWithIntl, unmountAll } from "@/test/react";
import { MessageList } from "./message-list";

// Scrolling and markdown rendering are unrelated to the message actions.
vi.mock("@sourceweft/ui-web/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ConversationContent: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
  ConversationKeyboardAnchor: () => null,
  ConversationScrollButton: () => null,
}));
vi.mock("./message-response", () => ({
  CitationAwareMessageResponse: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
}));

afterEach(unmountAll);

const groups = [
  {
    groupId: "user",
    role: "user" as const,
    latestVersionId: "message-1",
    versions: [{ id: "message-1", content: "Summarize the week" }],
  },
];

function editPrompt(container: HTMLElement) {
  return [...container.querySelectorAll("button")].filter((button) =>
    (button.getAttribute("aria-label") ?? button.textContent ?? "").includes(
      "Edit prompt",
    ),
  );
}

test("a read-only viewer gets no Edit prompt pencil at all", async () => {
  const { container } = await mountWithIntl(
    <MessageList messageGroups={groups} readOnly />,
  );
  assert.equal(editPrompt(container).length, 0);
});

test("an ordinary conversation that cannot restart right now keeps the pencil, disabled", async () => {
  const { container } = await mountWithIntl(
    <MessageList messageGroups={groups} />,
  );
  const [pencil] = editPrompt(container);
  assert.ok(pencil, "the pencil is rendered");
  assert.equal(pencil.disabled, true);
});
