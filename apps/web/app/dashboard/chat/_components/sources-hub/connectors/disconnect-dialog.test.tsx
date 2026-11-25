// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import type { SourceConnector } from "@sourceweft/sdk";
import { mountWithIntl, unmountAll } from "@/test/react";
import { ConnectorDisconnectDialog } from "./disconnect-dialog";
import type { ConnectorItem } from "./types";

afterEach(unmountAll);

function connectorOfType(connectorType: string): ConnectorItem {
  return {
    id: `${connectorType}-1`,
    name: connectorType,
    status: "active",
    meta: "",
    raw: {
      id: `${connectorType}-1`,
      connectorType,
      name: connectorType,
      status: "active",
    } as SourceConnector,
  };
}

const connector = connectorOfType("gmail");

function renderDialog(
  broker: string | null,
  item: ConnectorItem = connector,
) {
  return mountWithIntl(
    createElement(ConnectorDisconnectDialog, {
      broker,
      connector: item,
      hardDelete: true,
      isBusy: false,
      onConfirm: vi.fn(),
      onHardDeleteChange: vi.fn(),
      onOpenChange: vi.fn(),
    }),
  );
}

const NEXTCLOUD_NOTE =
  "you can delete it in Nextcloud under Settings > Security";

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

test("a Nextcloud (login_flow) connector shows the manual app-password removal note", async () => {
  await renderDialog(null, connectorOfType("nextcloud"));
  expect(document.body.textContent ?? "").toContain(NEXTCLOUD_NOTE);
});

test("a non-login-flow connector does not show the manual app-password note", async () => {
  await renderDialog(null, connectorOfType("gmail"));
  expect(document.body.textContent ?? "").not.toContain(NEXTCLOUD_NOTE);
});
