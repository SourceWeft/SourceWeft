// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act } from "react";
import { afterEach, test, vi } from "vitest";
import { flush, mount, unmountAll } from "@/test/react";
import {
  PromptInput,
  PromptInputMentionEditor,
  PromptInputProvider,
  usePromptInputController,
  type PromptInputControllerProps,
  type PromptInputMessage,
  type PromptInputSegment,
} from "@sourceweft/ui-web/components/ai-elements/prompt-input";

afterEach(unmountAll);

type ValueChange = {
  mentionedSourceIds: string[];
  segments: PromptInputSegment[];
  text: string;
};

let controller: PromptInputControllerProps | null = null;

function Probe() {
  controller = usePromptInputController();
  return null;
}

// Read the captured controller without the flow-narrowing that `controller = null`
// would otherwise apply (TypeScript cannot see that <Probe /> reassigns it).
function getController() {
  return controller;
}

async function renderEditor(
  options: { initialValue?: string; withSubmit?: boolean } = {},
) {
  controller = null;
  const changes: ValueChange[] = [];
  const onSubmit = vi.fn<(message: PromptInputMessage) => void>();

  const view = await mount(
    <PromptInputProvider>
      <Probe />
      <PromptInput onSubmit={onSubmit}>
        <PromptInputMentionEditor
          initialValue={options.initialValue}
          onValueChange={(change) => changes.push(change)}
          sources={[]}
        />
        <button type="button">Mic</button>
        {options.withSubmit ? <button type="submit">Send</button> : null}
      </PromptInput>
    </PromptInputProvider>,
  );

  const editor = view.container.querySelector<HTMLElement>(
    '[data-prompt-input-editor="true"]',
  );
  assert.ok(editor, "editor rendered");
  const form = view.container.querySelector("form");
  assert.ok(form, "form rendered");

  return { changes, editor, form, onSubmit, view };
}

function clearSelection() {
  document.getSelection()?.removeAllRanges();
}

function setCaret(node: Node, start: number, end = start) {
  const selection = document.getSelection();
  assert.ok(selection, "selection available");
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

/** The editor text that precedes the live, collapsed caret. */
function textBeforeCaret(editor: HTMLElement) {
  const selection = document.getSelection();
  assert.ok(selection && selection.rangeCount > 0, "live selection present");
  const caret = selection.getRangeAt(0);
  assert.equal(caret.collapsed, true, "caret is collapsed");
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(caret.startContainer, caret.startOffset);
  return range.toString();
}

/** Fire a paste of plain text at the live caret, the way the browser would. */
async function pasteText(editor: HTMLElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  await act(async () => {
    editor.dispatchEvent(event);
  });
  await flush();
}

async function insert(text: string) {
  const captured = getController();
  assert.ok(captured, "controller captured");
  let returned = false;
  await act(async () => {
    returned = captured.insertText(text);
  });
  await flush();
  return returned;
}

test("inserts at the end when the editor has never had a selection", async () => {
  clearSelection();
  const { editor, changes } = await renderEditor();

  const returned = await insert("hello");

  assert.equal(returned, true);
  assert.equal(editor.textContent, "hello");
  assert.equal(changes.at(-1)?.text, "hello");
});

test("inserts at the remembered caret after focus moved to a button", async () => {
  const { editor, changes, view } = await renderEditor({ initialValue: "abcd" });

  const textNode = editor.firstChild;
  assert.ok(textNode, "initial text node");
  setCaret(textNode, 2);

  // Focus leaves the editor for a toolbar button; the live selection is no
  // longer inside the editor, so the remembered caret must be used.
  const micButton = view.container.querySelector("button");
  assert.ok(micButton?.firstChild, "mic button text");
  const selection = document.getSelection();
  selection?.removeAllRanges();
  const outside = document.createRange();
  outside.setStart(micButton.firstChild, 0);
  outside.collapse(true);
  selection?.addRange(outside);

  await insert("X");

  assert.equal(editor.textContent, "abXcd");
  assert.equal(changes.at(-1)?.text, "abXcd");
});

test("replaces a selected range", async () => {
  const { editor, changes } = await renderEditor({ initialValue: "abcd" });

  const textNode = editor.firstChild;
  assert.ok(textNode, "initial text node");
  setCaret(textNode, 1, 3);

  await insert("X");

  assert.equal(editor.textContent, "aXd");
  assert.equal(changes.at(-1)?.text, "aXd");
});

test("inserts after a mention chip when the caret is inside it", async () => {
  const { editor, changes } = await renderEditor({
    initialValue: "[source:doc-1](My Doc)",
  });

  const chip = editor.querySelector<HTMLElement>("[data-source-mention-id]");
  assert.ok(chip?.firstChild, "mention chip rendered");
  assert.equal(chip.dataset.sourceMentionId, "doc-1");
  setCaret(chip.firstChild, 3);

  await insert(" after");

  const chipAfter = editor.querySelector<HTMLElement>(
    "[data-source-mention-id]",
  );
  assert.ok(chipAfter, "mention chip still present");
  assert.equal(chipAfter.dataset.sourceMentionId, "doc-1");
  assert.equal(editor.textContent, "@My Doc after");
  assert.equal(changes.at(-1)?.text, "[source:doc-1](My Doc) after");
  assert.deepEqual(changes.at(-1)?.mentionedSourceIds, ["doc-1"]);
});

test("appends at the end while an input method is composing", async () => {
  const { editor } = await renderEditor({ initialValue: "abcd" });

  const textNode = editor.firstChild;
  assert.ok(textNode, "initial text node");
  setCaret(textNode, 2);

  await act(async () => {
    editor.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
  });

  await insert("X");

  assert.equal(editor.textContent, "abcdX");
});

test("the submitted text contains the inserted text", async () => {
  clearSelection();
  const { form, onSubmit } = await renderEditor({ withSubmit: true });

  await insert("dictated words");

  await act(async () => {
    form.requestSubmit();
  });
  await flush();

  assert.equal(onSubmit.mock.calls.length, 1);
  assert.equal(onSubmit.mock.calls[0]?.[0]?.text, "dictated words");
});

test("restores the caret after the pasted text", async () => {
  const { editor } = await renderEditor({ initialValue: "abcd" });

  const textNode = editor.firstChild;
  assert.ok(textNode, "initial text node");
  setCaret(textNode, 2);

  await pasteText(editor, "X");

  assert.equal(editor.textContent, "abXcd");
  assert.equal(textBeforeCaret(editor), "abX");
});

test("advances the live caret to after the inserted text", async () => {
  const { editor } = await renderEditor({ initialValue: "abcd" });

  const textNode = editor.firstChild;
  assert.ok(textNode, "initial text node");
  setCaret(textNode, 2);

  await insert("X");

  assert.equal(editor.textContent, "abXcd");
  assert.equal(textBeforeCaret(editor), "abX");
});

test("leaves an outside selection untouched when inserting at the remembered caret", async () => {
  const { editor, view } = await renderEditor({ initialValue: "abcd" });

  const textNode = editor.firstChild;
  assert.ok(textNode, "initial text node");
  setCaret(textNode, 2);

  // Move the live selection to a toolbar button outside the editor.
  const micButton = view.container.querySelector("button");
  assert.ok(micButton?.firstChild, "mic button text");
  const selection = document.getSelection();
  selection?.removeAllRanges();
  const outside = document.createRange();
  outside.setStart(micButton.firstChild, 0);
  outside.collapse(true);
  selection?.addRange(outside);

  await insert("X");

  assert.equal(editor.textContent, "abXcd");
  const after = document.getSelection();
  assert.ok(after?.anchorNode, "selection still present");
  assert.equal(
    editor.contains(after.anchorNode),
    false,
    "selection was not pulled into the editor",
  );
  assert.ok(
    micButton.contains(after.anchorNode),
    "selection stayed on the outside element",
  );
});

test("insertText returns false when no mention editor is mounted", async () => {
  controller = null;
  await mount(
    <PromptInputProvider>
      <Probe />
    </PromptInputProvider>,
  );

  const captured = getController();
  assert.ok(captured, "controller captured");
  assert.equal(captured.insertText("anything"), false);
});
