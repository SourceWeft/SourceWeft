// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readStoredMcpSelection } from "../../chat/_components/mcp-selection-storage";
import { selectInstallForChat } from "./mcp-use-in-chat";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("selectInstallForChat", () => {
  it("selects the install for a new chat without sending anything", () => {
    const destination = selectInstallForChat({
      workspaceId: "ws-1",
      installId: "install-1",
      origin: null,
    });
    expect(destination).toBe("/dashboard/chat");
    expect(readStoredMcpSelection("ws-1", "current")).toEqual({
      installIds: ["install-1"],
      toolIds: [],
    });
  });

  it("returns to the chat thread the flow began in, selecting there", () => {
    const destination = selectInstallForChat({
      workspaceId: "ws-1",
      installId: "install-1",
      origin: "/dashboard/chat/thread-9",
    });
    expect(destination).toBe("/dashboard/chat/thread-9");
    expect(readStoredMcpSelection("ws-1", "thread-9").installIds).toEqual([
      "install-1",
    ]);
    expect(readStoredMcpSelection("ws-1", "current").installIds).toEqual([]);
  });

  it("keeps the existing selection and does not add the install twice", () => {
    window.localStorage.setItem(
      "chat:mcp:ws-1:current",
      JSON.stringify({ installIds: ["other"], toolIds: ["tool-1"] }),
    );
    for (let i = 0; i < 2; i += 1) {
      selectInstallForChat({
        workspaceId: "ws-1",
        installId: "install-1",
        origin: "/mcp/public-page",
      });
    }
    expect(readStoredMcpSelection("ws-1", "current")).toEqual({
      installIds: ["other", "install-1"],
      toolIds: ["tool-1"],
    });
  });

  it("selects within its own workspace only", () => {
    selectInstallForChat({
      workspaceId: "ws-1",
      installId: "install-1",
      origin: null,
    });
    expect(readStoredMcpSelection("ws-2", "current").installIds).toEqual([]);
  });
});
