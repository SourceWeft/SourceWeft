"use client";

import { useEffect, useRef } from "react";
import { usePromptInputController } from "@sourceweft/ui-web/components/ai-elements/prompt-input";

/**
 * Lets code outside the composer (an artifact viewer's "ask in chat") put text
 * into the current thread's composer without sending it. The composer mounts
 * `ComposerInsertSlot` inside its prompt provider; `insertIntoComposer` hands
 * the text to the most recently mounted one.
 */
type Inserter = (text: string) => boolean;

const inserters: Inserter[] = [];

/** Inserts at the composer's cursor. False when no composer is mounted. */
export function insertIntoComposer(text: string): boolean {
  const insert = inserters.at(-1);
  return insert ? insert(text) : false;
}

/** Mounted inside the composer's `PromptInputProvider`; renders nothing. */
export function ComposerInsertSlot() {
  const controller = usePromptInputController();
  // The controller is rebuilt on every keystroke; insertText itself is stable.
  const insertRef = useRef(controller.insertText);
  insertRef.current = controller.insertText;

  useEffect(() => {
    const inserter: Inserter = (text) => insertRef.current(text);
    inserters.push(inserter);
    return () => {
      const index = inserters.indexOf(inserter);
      if (index >= 0) inserters.splice(index, 1);
    };
  }, []);

  return null;
}
