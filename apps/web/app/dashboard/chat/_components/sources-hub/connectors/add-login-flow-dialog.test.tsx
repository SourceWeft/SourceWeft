// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { HttpClientError } from "@sourceweft/sdk";
import {
  button,
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";
import {
  AddLoginFlowDialog,
  type LoginFlowDialogProps,
} from "./add-login-flow-dialog";

// The Radix Checkbox measures itself with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

const FLOW_ID = "flow-secret-abc123def456";
const LOGIN_URL = "https://cloud.example.com/index.php/login/v2/flow/opaque";

let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  openSpy = vi
    .spyOn(window, "open")
    .mockReturnValue(null as unknown as Window);
});

afterEach(async () => {
  await unmountAll();
  openSpy.mockRestore();
  vi.useRealTimers();
});

type Pending = { status: "pending" };
type Expired = { status: "expired" };
type Connected = { status: "connected"; connector: { id: string } };

function connectedResult(id = "nc-1"): Connected {
  return {
    status: "connected",
    connector: { id },
  };
}

async function mountDialog(
  overrides: Partial<LoginFlowDialogProps> = {},
) {
  const onStart = vi
    .fn()
    .mockResolvedValue({ flowId: FLOW_ID, loginUrl: LOGIN_URL });
  const onPoll = vi.fn().mockResolvedValue({ status: "pending" } as Pending);
  const onCancel = vi.fn().mockResolvedValue(undefined);
  const onConnected = vi.fn();
  const onOpenChange = vi.fn();
  await mountWithIntl(
    createElement(AddLoginFlowDialog, {
      open: true,
      onOpenChange,
      reconnect: null,
      onStart,
      onPoll,
      onCancel,
      onConnected,
      ...overrides,
    } as LoginFlowDialogProps),
  );
  return { onStart, onPoll, onCancel, onConnected, onOpenChange };
}

function serverField() {
  return document.querySelector<HTMLInputElement>(
    'input[name="nextcloudServer"]',
  )!;
}

function bodyText() {
  return document.body.textContent ?? "";
}

/** Advance fake timers inside act so the setTimeout poll chain fires. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Fill a valid server and click Connect; let the start promise settle. */
async function connect() {
  typeInto(serverField(), "https://cloud.example.com");
  await flush(2);
  await click(button("Connect with Nextcloud"));
  await flush(4);
}

test("the add dialog shows the server form and no password field", async () => {
  await mountDialog();
  expect(serverField()).not.toBeNull();
  expect(
    document.querySelector('input[type="password"]'),
  ).toBeNull();
  expect(bodyText()).toContain("Connect with Nextcloud");
});

test("an invalid server URL is rejected without starting the flow", async () => {
  const { onStart } = await mountDialog();
  typeInto(serverField(), "cloud.example.com/no-scheme");
  await flush(2);
  await click(button("Connect with Nextcloud"));
  await flush(2);
  expect(onStart).not.toHaveBeenCalled();
  expect(bodyText()).toContain("without a username, password or query string");
});

test("Connect starts the flow, opens the login URL in a new tab, and waits", async () => {
  const { onStart } = await mountDialog();
  await connect();

  expect(onStart).toHaveBeenCalledWith({
    serverUrl: "https://cloud.example.com",
    name: "cloud.example.com",
    roots: ["/"],
    periodicIndexingEnabled: false,
  });
  // Opened with exactly the returned URL and the hardening flags; never the
  // flow id or any secret.
  expect(openSpy).toHaveBeenCalledWith(
    LOGIN_URL,
    "_blank",
    "noopener,noreferrer",
  );
  expect(openSpy).toHaveBeenCalledTimes(1);
  expect(openSpy.mock.calls[0]![0]).toBe(LOGIN_URL);
  expect(openSpy.mock.calls[0]![0]).not.toContain(FLOW_ID);
  expect(bodyText()).toContain("Waiting for approval");
});

test("the waiting state offers an 'open again' fallback that reopens the same URL", async () => {
  await mountDialog();
  await connect();
  openSpy.mockClear();
  await click(button("Open Nextcloud again"));
  expect(openSpy).toHaveBeenCalledWith(
    LOGIN_URL,
    "_blank",
    "noopener,noreferrer",
  );
});

test("a connected poll calls onConnected with the connector and closes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const onPoll = vi.fn().mockResolvedValue(connectedResult("nc-9"));
  const { onConnected, onOpenChange } = await mountDialog({ onPoll });
  await connect();
  await advance(2000);

  expect(onPoll).toHaveBeenCalledWith(FLOW_ID);
  expect(onConnected).toHaveBeenCalledWith({ id: "nc-9" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("polling is sequential, two seconds apart, and never overlaps", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const onPoll = vi.fn().mockResolvedValue({ status: "pending" } as Pending);
  await mountDialog({ onPoll });
  await connect();

  expect(onPoll).toHaveBeenCalledTimes(0);
  await advance(2000);
  expect(onPoll).toHaveBeenCalledTimes(1);
  await advance(2000);
  expect(onPoll).toHaveBeenCalledTimes(2);
  // Only one request is ever in flight: advancing a fraction never adds a call.
  await advance(1000);
  expect(onPoll).toHaveBeenCalledTimes(2);
});

test("Cancel calls the delete route with the flow id and stops polling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const onPoll = vi.fn().mockResolvedValue({ status: "pending" } as Pending);
  const { onCancel, onOpenChange } = await mountDialog({ onPoll });
  await connect();
  await advance(2000);
  expect(onPoll).toHaveBeenCalledTimes(1);

  await click(button("Cancel"));
  expect(onCancel).toHaveBeenCalledWith(FLOW_ID);
  expect(onOpenChange).toHaveBeenCalledWith(false);

  await advance(6000);
  expect(onPoll).toHaveBeenCalledTimes(1);
});

test("closing (unmounting) the dialog stops polling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const onPoll = vi.fn().mockResolvedValue({ status: "pending" } as Pending);
  await mountDialog({ onPoll });
  await connect();
  await advance(2000);
  expect(onPoll).toHaveBeenCalledTimes(1);

  await unmountAll();
  await advance(6000);
  expect(onPoll).toHaveBeenCalledTimes(1);
});

test("an expired poll shows the expired message and stops polling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const onPoll = vi.fn().mockResolvedValue({ status: "expired" } as Expired);
  await mountDialog({ onPoll });
  await connect();
  await advance(2000);

  expect(bodyText()).toContain("login approval expired");
  await advance(6000);
  expect(onPoll).toHaveBeenCalledTimes(1);
});

test("the flow gives up with a message after ten minutes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const onPoll = vi.fn().mockResolvedValue({ status: "pending" } as Pending);
  await mountDialog({ onPoll });
  await connect();
  await advance(10 * 60 * 1000 + 2000);

  expect(bodyText()).toContain("was not approved in time");
});

test.each([
  ["NEXTCLOUD_UNREACHABLE", "could not be reached"],
  ["NEXTCLOUD_LOGIN_FLOW_UNSUPPORTED", "does not look like a Nextcloud"],
  ["NEXTCLOUD_LOGIN_FLOW_INVALID", "login response was not valid"],
  ["NEXTCLOUD_BLOCKED_ENDPOINT", "not allowed by this deployment"],
  ["CONNECTOR_CREDENTIAL_FLOW_LIMIT", "Too many logins"],
  ["CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS", "already exists in this workspace"],
  ["CONNECTOR_CREDENTIAL_FLOW_MISMATCH", "does not match the connector"],
  ["CONNECTOR_CREDENTIAL_FLOW_UNSUPPORTED", "does not support signing in"],
])(
  "a %s start failure shows its localized message",
  async (code, text) => {
    const onStart = vi.fn().mockRejectedValue(
      new HttpClientError({
        message: "x",
        status: 400,
        statusText: "Bad Request",
        code,
      }),
    );
    await mountDialog({ onStart });
    await connect();
    expect(bodyText()).toContain(text);
  },
);

test("a config-not-ready failure maps its readiness reason", async () => {
  const onStart = vi.fn().mockRejectedValue(
    new HttpClientError({
      message: "x",
      status: 400,
      statusText: "Bad Request",
      code: "CONNECTOR_CONFIG_NOT_READY",
      details: { reason: "not_nextcloud" },
    }),
  );
  await mountDialog({ onStart });
  await connect();
  expect(bodyText()).toContain("does not look like a Nextcloud");
});

test("neither the flow id nor the login URL is written to storage", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const localSet = vi.spyOn(Storage.prototype, "setItem");
  const onPoll = vi.fn().mockResolvedValue(connectedResult());
  await mountDialog({ onPoll });
  await connect();
  await advance(2000);

  for (const call of localSet.mock.calls) {
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain(FLOW_ID);
    expect(serialized).not.toContain(LOGIN_URL);
  }
  localSet.mockRestore();
});

test("reconnect runs the flow at once with no form and no password field", async () => {
  const onStart = vi
    .fn()
    .mockResolvedValue({ flowId: FLOW_ID, loginUrl: LOGIN_URL });
  await mountDialog({
    onStart,
    reconnect: {
      connectorName: "My Nextcloud",
      serverUrl: "https://cloud.example.com",
    },
  });
  await flush(4);

  expect(onStart).toHaveBeenCalledWith({
    serverUrl: "https://cloud.example.com",
    name: "My Nextcloud",
  });
  expect(openSpy).toHaveBeenCalledWith(
    LOGIN_URL,
    "_blank",
    "noopener,noreferrer",
  );
  // No server form and no password field in reconnect mode.
  expect(
    document.querySelector('input[name="nextcloudServer"]'),
  ).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(bodyText()).toContain("Reconnect Nextcloud");
  expect(bodyText()).toContain("Waiting for approval");
});
