// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceMcpInstallSchema } from "@sourceweft/contracts";
import { HttpClientError, type WorkspaceMcpInstall } from "@sourceweft/sdk";

import {
  button,
  buttons,
  click,
  flush,
  mountWithIntl,
  unmountAll,
  type Mounted,
  withIntl,
} from "@/test/react";

const api = vi.hoisted(() => ({
  authorizeWorkspaceMcpOAuth: vi.fn(),
  discoverWorkspaceMcpTools: vi.fn(),
  upsertWorkspaceMcpCredentials: vi.fn(),
}));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { CredentialsDialog } from "./mcp-credentials-dialog";

function oauthInstall(
  patch: Partial<WorkspaceMcpInstall> = {},
): WorkspaceMcpInstall {
  return {
    ...workspaceMcpInstallSchema.parse({
      authType: "oauth",
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: null,
      credentialStatus: "required",
      desktopOnly: false,
      enabled: true,
      endpointUrl: "https://mcp.example/mcp",
      id: "install-1",
      lastError: null,
      lastTestedAt: null,
      manifestJson: {
        auth: { type: "oauth", required: true },
        endpointUrl: "https://mcp.example/mcp",
        identifier: "io.github.o/example",
        name: "Example",
        schemaVersion: 1,
        summary: "An example server.",
        transport: "streamable_http",
        version: "1.0.0",
      },
      marketIdentifier: "io.github.o/example",
      marketVersion: "1.0.0",
      name: "Example",
      official: false,
      signature: null,
      signingKeyId: null,
      source: "market",
      status: "active",
      summary: "An example server.",
      teamId: "team-1",
      transport: "streamable_http",
      updatedAt: "2026-10-01T00:00:00.000Z",
      verified: false,
      webExecutable: true,
      workspaceId: "ws-1",
    }),
    ...patch,
  };
}

const onClose = vi.fn();
const onSaved = vi.fn();
const onUseInChat = vi.fn();
const navigate = vi.fn();

type Props = Partial<React.ComponentProps<typeof CredentialsDialog>>;
const element = (props: Props = {}) => (
  <CredentialsDialog
    install={oauthInstall()}
    navigate={navigate}
    onClose={onClose}
    onSaved={onSaved}
    onUseInChat={onUseInChat}
    open
    returnTo="/dashboard/mcp/io.github.o%2Fexample"
    workspaceId="ws-1"
    {...props}
  />
);
async function open(props: Props = {}): Promise<Mounted> {
  return mountWithIntl(element(props));
}

const dialog = () =>
  document.body.querySelector<HTMLElement>('[role="dialog"]')!;
const text = () => dialog().textContent ?? "";
const connect = () => button("Connect", dialog());
const spinning = () => dialog().querySelector(".animate-spin") !== null;

/** A request that stays pending until the test settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TOOLS = {
  tools: [
    { name: "whoami", description: "Says who.", readOnly: true, destructive: false },
  ],
  toolCount: 1,
  truncated: false,
  skippedOversize: 0,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("connecting with OAuth", () => {
  it("asks for the provider's URL with the return destination, then says where it is going", async () => {
    api.authorizeWorkspaceMcpOAuth.mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.vendor.example/authorize?x=1",
    });
    await open();
    await click(connect());
    await flush(2);

    expect(api.authorizeWorkspaceMcpOAuth).toHaveBeenCalledWith(
      "ws-1",
      "install-1",
      expect.objectContaining({
        returnTo: "/dashboard/mcp/io.github.o%2Fexample",
      }),
    );
    expect(navigate).toHaveBeenCalledWith(
      "https://auth.vendor.example/authorize?x=1",
    );
    expect(text()).toContain("Opening auth.vendor.example…");
    expect(buttons("Cancel", dialog()).length).toBeGreaterThan(0);
  });

  it("shows a progress message and a Cancel while the request is slow", async () => {
    const slow = deferred<unknown>();
    api.authorizeWorkspaceMcpOAuth.mockReturnValue(slow.promise);
    await open();
    await click(connect());

    expect(text()).toContain("Contacting the sign-in service…");
    expect(spinning()).toBe(true);
    expect(connect().disabled).toBe(true);
    expect(buttons("Cancel", dialog()).length).toBeGreaterThan(0);
  });

  it("ignores a late response after Cancel instead of leaving the page", async () => {
    const slow = deferred<unknown>();
    api.authorizeWorkspaceMcpOAuth.mockReturnValue(slow.promise);
    await open();
    await click(connect());
    await click(buttons("Cancel", dialog())[0]!);

    expect(spinning()).toBe(false);
    expect(connect().disabled).toBe(false);
    // The request itself is aborted, and an answer that still arrives is dropped.
    const signal = api.authorizeWorkspaceMcpOAuth.mock.calls[0]![2].signal;
    expect(signal.aborted).toBe(true);
    await act(async () => {
      slow.resolve({
        status: "redirect",
        authorizationUrl: "https://auth.vendor.example/late",
      });
    });
    await flush(2);
    expect(navigate).not.toHaveBeenCalled();
    expect(spinning()).toBe(false);
  });

  it("drops a late response after the dialog was closed", async () => {
    const slow = deferred<unknown>();
    api.authorizeWorkspaceMcpOAuth.mockReturnValue(slow.promise);
    const mounted = await open();
    await click(connect());
    await mounted.render(withIntl(element({ open: false })));
    await act(async () => {
      slow.resolve({
        status: "redirect",
        authorizationUrl: "https://auth.vendor.example/late",
      });
    });
    await flush(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("starts idle again when the dialog is reopened", async () => {
    const slow = deferred<unknown>();
    api.authorizeWorkspaceMcpOAuth.mockReturnValue(slow.promise);
    const mounted = await open();
    await click(connect());
    expect(spinning()).toBe(true);
    await mounted.render(withIntl(element({ open: false })));
    await mounted.render(withIntl(element({ open: true })));
    expect(spinning()).toBe(false);
    expect(connect().disabled).toBe(false);
  });

  it("ends a pending connect when the page is restored from the cache, timers included", async () => {
    api.authorizeWorkspaceMcpOAuth.mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.vendor.example/authorize",
    });
    await open();
    await click(connect());
    await flush(2);
    expect(text()).toContain("Opening auth.vendor.example…");

    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event("pageshow"), { persisted: true }),
      );
    });
    expect(spinning()).toBe(false);
    expect(connect().disabled).toBe(false);
    // The redirect guard died with the attempt: no late "did not open" error.
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    expect(text()).not.toContain("The sign-in page did not open.");
  });

  it("ignores a pageshow that is not a cache restore", async () => {
    api.authorizeWorkspaceMcpOAuth.mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.vendor.example/authorize",
    });
    await open();
    await click(connect());
    await flush(2);
    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event("pageshow"), { persisted: false }),
      );
    });
    expect(text()).toContain("Opening auth.vendor.example…");
  });

  it("falls back to the market page when the page's own path would be refused", async () => {
    api.authorizeWorkspaceMcpOAuth.mockReturnValue(new Promise(() => {}));
    await open({ returnTo: "/dashboard/mcp/io.github.o%2Fwhat(is)this!" });
    await click(connect());
    expect(api.authorizeWorkspaceMcpOAuth).toHaveBeenCalledWith(
      "ws-1",
      "install-1",
      expect.objectContaining({ returnTo: "/dashboard/mcp" }),
    );
  });

  it("never navigates to anything but a web address", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
      api.authorizeWorkspaceMcpOAuth.mockResolvedValueOnce({
        status: "redirect",
        authorizationUrl: url,
      });
      await open();
      await click(connect());
      await flush(2);
      expect(navigate).not.toHaveBeenCalled();
      expect(spinning()).toBe(false);
      expect(text()).toContain("Failed to start authorization.");
      await unmountAll();
    }
  });

  it("recovers when the browser never leaves for the provider", async () => {
    api.authorizeWorkspaceMcpOAuth.mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.vendor.example/authorize",
    });
    await open();
    await click(connect());
    await flush(2);
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    expect(spinning()).toBe(false);
    expect(text()).toContain("The sign-in page did not open.");
    expect(connect().disabled).toBe(false);
  });

  it("gives up on a request nobody answers and says so", async () => {
    api.authorizeWorkspaceMcpOAuth.mockReturnValue(new Promise(() => {}));
    await open();
    await click(connect());
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(spinning()).toBe(false);
    expect(text()).toContain("The sign-in service did not answer in time.");
    const signal = api.authorizeWorkspaceMcpOAuth.mock.calls[0]![2].signal;
    expect(signal.aborted).toBe(true);
  });

  it("shows the server's timeout code readably and lets the member retry", async () => {
    api.authorizeWorkspaceMcpOAuth.mockRejectedValue(
      new HttpClientError({
        message: "The MCP server's sign-in did not answer in time",
        status: 504,
        statusText: "Gateway Timeout",
        code: "MCP_OAUTH_TIMEOUT",
      }),
    );
    await open();
    await click(connect());
    await flush(2);
    expect(text()).toContain("The sign-in service did not answer in time. Try again.");
    expect(spinning()).toBe(false);
    expect(connect().disabled).toBe(false);
  });

  it("goes straight to the member's tool list when already connected", async () => {
    api.authorizeWorkspaceMcpOAuth.mockResolvedValue({ status: "connected" });
    const pending = deferred<typeof TOOLS>();
    api.discoverWorkspaceMcpTools.mockReturnValue(pending.promise);
    await open();
    await click(connect());
    await flush(2);

    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedVia: "oauth",
        credentialStatus: "configured",
      }),
    );
    expect(text()).toContain("Checking which tools you can use…");
    await act(async () => pending.resolve(TOOLS));
    await flush(2);
    expect(text()).toContain("1 tool is available to you");
    expect(text()).toContain("whoami");
    expect(text()).toContain("Only you see this list");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the result of a connection", () => {
  it("lists the tools on return from the provider and offers Use in chat", async () => {
    api.discoverWorkspaceMcpTools.mockResolvedValue(TOOLS);
    await open({ resumeConnected: true });
    await flush(3);
    expect(api.discoverWorkspaceMcpTools).toHaveBeenCalledWith(
      "ws-1",
      "install-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text()).toContain("whoami");
    await click(button("Use in chat", dialog()));
    expect(onUseInChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: "install-1" }),
    );
  });

  it("says why a listing failed and retries on request, without closing", async () => {
    api.discoverWorkspaceMcpTools.mockRejectedValueOnce(
      new HttpClientError({
        message: "x",
        status: 400,
        statusText: "Bad Request",
        code: "MCP_OAUTH_NOT_CONNECTED",
      }),
    );
    api.discoverWorkspaceMcpTools.mockResolvedValueOnce(TOOLS);
    await open({ resumeConnected: true });
    await flush(3);
    expect(text()).toContain("This connection is no longer active.");
    expect(buttons("Use in chat", dialog())).toHaveLength(0);
    await click(button("Try again", dialog()));
    await flush(3);
    expect(text()).toContain("whoami");
  });

  it("names what was left out of a bounded listing", async () => {
    api.discoverWorkspaceMcpTools.mockResolvedValue({
      tools: TOOLS.tools,
      toolCount: 500,
      truncated: true,
      skippedOversize: 2,
    });
    await open({ resumeConnected: true });
    await flush(3);
    expect(text()).toContain("Showing the first 1.");
    expect(text()).toContain("2 tools were left out");
  });

  it("cancels a listing in progress without acting on its answer", async () => {
    const slow = deferred<typeof TOOLS>();
    api.discoverWorkspaceMcpTools.mockReturnValue(slow.promise);
    await open({ resumeConnected: true });
    await flush(2);
    expect(spinning()).toBe(true);
    await click(buttons("Cancel", dialog())[0]!);
    await act(async () => slow.resolve(TOOLS));
    await flush(2);
    expect(text()).not.toContain("whoami");
  });
});
