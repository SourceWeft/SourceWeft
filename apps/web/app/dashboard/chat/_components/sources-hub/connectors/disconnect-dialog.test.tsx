// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import type { SourceConnector } from "@sourceweft/sdk";
import { mountWithIntl, unmountAll } from "@/test/react";
import { ConnectorDisconnectDialog } from "./disconnect-dialog";
import type { ConnectorItem } from "./types";

afterEach(unmountAll);

const connector: ConnectorItem = {
  id: "gmail-1",
  name: "Gmail",
  status: "active",
  meta: "",
  raw: {
    id: "gmail-1",
    connectorType: "gmail",
    name: "Gmail",
    status: "active",
  } as SourceConnector,
};

function renderDialog(broker: string | null) {
  return mountWithIntl(
    createElement(ConnectorDisconnectDialog, {
      broker,
      connector,
      hardDelete: true,
      isBusy: false,
      onConfirm: vi.fn(),
      onHardDeleteChange: vi.fn(),
      onOpenChange: vi.fn(),
    }),
  );
}

test("a Composio-brokered connector says deleting removes the Composio connection", async () => {
  await renderDialog("composio");
  const text = document.body.textContent ?? "";
  expect(text).toContain(
    "Deleting also removes the connection at Composio, which ends access to this account.",
  );
  expect(text).not.toContain(
    "SourceWeft will not revoke access in the third-party provider.",
  );
});

test("a standard OAuth connector keeps the note that the provider grant stays", async () => {
  await renderDialog(null);
  const text = document.body.textContent ?? "";
  expect(text).toContain(
    "SourceWeft will not revoke access in the third-party provider.",
  );
  expect(text).not.toContain("Composio");
});
