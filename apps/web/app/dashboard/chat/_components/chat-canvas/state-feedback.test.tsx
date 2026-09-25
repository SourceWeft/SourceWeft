// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import {
  MessageBranch,
  MessageBranchContent,
  MessageBranchPage,
  MessageBranchSelector,
} from "@sourceweft/ui-web/components/ai-elements/message";
import {
  initialToolConfirmationControllerState,
  syncToolConfirmationRun,
} from "./tool-confirmation-controller";

test("unchanged confirmations preserve state identity even with fresh empty input arrays", () => {
  const state = syncToolConfirmationRun({
    items: [],
    runKey: "run-1",
    state: initialToolConfirmationControllerState,
  });
  expect(syncToolConfirmationRun({ items: [], runKey: "run-1", state })).toBe(
    state,
  );
});

test("confirmation synchronization settles when upstream references change on every render", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  let renders = 0;
  function Controller() {
    const [state, setState] = useState(initialToolConfirmationControllerState);
    // Deliberately unstable input reproduces the production effect feedback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const items: [] = [];
    if (++renders > 12)
      throw new Error("Confirmation state feedback did not settle");
    useEffect(() => {
      setState((current) =>
        syncToolConfirmationRun({ items, runKey: "run-1", state: current }),
      );
    }, [items]);
    return <button data-run={state.runKey}>Stop</button>;
  }
  try {
    await act(async () => root.render(<Controller />));
    expect(host.textContent).toBe("Stop");
    expect(renders).toBeLessThan(5);
  } finally {
    await act(async () => root.unmount());
  }
});

test("branch count is derived in the render, without child-to-parent registration effects", () => {
  const html = renderToStaticMarkup(
    <MessageBranch>
      <MessageBranchContent>
        <p key="a">First</p>
        <p key="b">Second</p>
      </MessageBranchContent>
      <MessageBranchSelector>
        <MessageBranchPage />
      </MessageBranchSelector>
    </MessageBranch>,
  );
  expect(html).toContain("1 of 2");
});

test("streaming text and branch shrink/grow preserve valid branch navigation", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    for (let n = 1; n <= 40; n++) {
      const count = n < 20 ? 2 : n < 30 ? 1 : 3;
      await act(async () =>
        root.render(
          createElement(
            MessageBranch,
            { defaultBranch: count - 1 },
            createElement(
              MessageBranchContent,
              null,
              Array.from({ length: count }, (_, i) => (
                <p key={i}>{`${i}:${"token ".repeat(n)}`}</p>
              )),
            ),
            createElement(MessageBranchPage),
          ),
        ),
      );
      expect(host.textContent).toContain(`${count - 1}:`);
      expect(host.textContent).toContain(`${count} of ${count}`);
    }
  } finally {
    await act(async () => root.unmount());
  }
});
