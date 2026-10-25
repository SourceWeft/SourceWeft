// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mountWithIntl, unmountAll } from "@/test/react";

const api = vi.hoisted(() => ({ getWorkspaceMcpOAuthCompletion: vi.fn() }));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { useMcpOAuthReturn } from "./use-mcp-oauth-return";

const onConnected = vi.fn();
function Harness({ workspaceId }: { workspaceId: string | null }) {
  useMcpOAuthReturn({ workspaceId, onConnected });
  return null;
}
async function visit(search: string, workspaceId: string | null = "ws-1") {
  nav.search = search;
  await mountWithIntl(<Harness workspaceId={workspaceId} />);
  await flush(4);
}

beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard/mcp/io.github.o%2Fexample");
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

describe("returning from a provider's sign-in", () => {
  it("accepts a connection only after the API confirms its reference", async () => {
    api.getWorkspaceMcpOAuthCompletion.mockResolvedValue({
      workspaceId: "ws-1",
      installId: "install-1",
    });
    await visit("mcpOAuth=connected&mcpRef=abc123&keep=1");
    expect(api.getWorkspaceMcpOAuthCompletion).toHaveBeenCalledWith("abc123");
    expect(onConnected).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      installId: "install-1",
    });
    // The flags go, other parameters stay, and the encoded path is untouched.
    expect(nav.replace).toHaveBeenCalledWith(
      "/dashboard/mcp/io.github.o%2Fexample?keep=1",
    );
  });

  it("does not trust a bare ?mcpOAuth=connected", async () => {
    await visit("mcpOAuth=connected");
    expect(api.getWorkspaceMcpOAuthCompletion).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't confirm the connection. Open Connection to check it.",
    );
  });

  it("reports a reference the API does not know", async () => {
    api.getWorkspaceMcpOAuthCompletion.mockRejectedValue(new Error("404"));
    await visit("mcpOAuth=connected&mcpRef=forged");
    expect(onConnected).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't confirm the connection. Open Connection to check it.",
    );
  });

  it("ignores a confirmation for another workspace", async () => {
    api.getWorkspaceMcpOAuthCompletion.mockResolvedValue({
      workspaceId: "ws-other",
      installId: "install-1",
    });
    await visit("mcpOAuth=connected&mcpRef=abc123");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it.each([
    ["mcpOAuth=invalid", "This sign-in link expired or was already used. Connect again."],
    ["mcpOAuth=error&mcpReason=denied", "Sign-in was cancelled."],
    ["mcpOAuth=error&mcpReason=timeout", "The sign-in service did not answer in time. Try again."],
    ["mcpOAuth=error&mcpReason=failed", "MCP authorization failed. Please try again."],
  ])("explains %s", async (search, message) => {
    await visit(search);
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("waits for the workspace and handles the return once", async () => {
    api.getWorkspaceMcpOAuthCompletion.mockResolvedValue({
      workspaceId: "ws-1",
      installId: "install-1",
    });
    await visit("mcpOAuth=connected&mcpRef=abc123", null);
    expect(api.getWorkspaceMcpOAuthCompletion).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
