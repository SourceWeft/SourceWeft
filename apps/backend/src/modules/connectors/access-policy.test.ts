import { describe, expect, it, vi } from "vitest";
vi.mock("../preview", () => ({ previewAccessService: { isEnabled: vi.fn() } }));
import { ConnectorAccessPolicy } from "./access-policy";
import { ConnectorRegistry } from "./registry";

function policy(grants: Set<string>, enabled = true) {
  const preview = { isEnabled: vi.fn(async (id: string) => grants.has(id)) };
  const registry = {
    listManifests: () => (enabled ? [{ type: "gmail" }] : []),
    getManifest: () => {
      if (!enabled) throw new Error("Connector is disabled");
      return { type: "gmail" };
    },
  } as unknown as ConnectorRegistry;
  return {
    access: new ConnectorAccessPolicy(preview as never, registry),
    preview,
  };
}

describe("Gmail preview policy", () => {
  it("checks the current actor for interactive access and owner for background work", async () => {
    const grants = new Set(["owner", "actor"]);
    const { access } = policy(grants);
    const connection = { connectorType: "gmail", createdBy: "owner" };
    await access.requireConnection(connection, "actor");
    grants.delete("actor");
    await expect(
      access.requireConnection(connection, "actor"),
    ).rejects.toMatchObject({
      code: "CONNECTOR_PREVIEW_ACCESS_DENIED",
      statusCode: 403,
    });
    grants.add("actor");
    grants.delete("owner");
    await access.requireConnection(connection, "actor");
    await expect(access.requireConnection(connection)).rejects.toMatchObject({
      code: "CONNECTOR_PREVIEW_ACCESS_DENIED",
    });
  });
  it("blocks ownerless background work without a system fallback", async () => {
    const { access, preview } = policy(new Set(["system"]));
    await expect(
      access.requireConnection({ connectorType: "gmail", createdBy: null }),
    ).rejects.toMatchObject({ code: "CONNECTOR_PREVIEW_OWNER_REQUIRED" });
    expect(preview.isEnabled).not.toHaveBeenCalled();
  });
  it("deployment registration remains required even with a preview grant", async () => {
    const { access } = policy(new Set(["actor"]), false);
    expect(await access.isAvailable("gmail", "actor")).toBe(false);
    await expect(access.requireAvailable("gmail", "actor")).rejects.toThrow(
      "disabled",
    );
  });
  it("hides ineligible connections in tool discovery and leaves other types unchanged", async () => {
    const { access, preview } = policy(new Set());
    const other = { connectorType: "notion", createdBy: null };
    expect(
      await access.filterAvailable(
        [other, { connectorType: "gmail", createdBy: "owner" }],
        "actor",
      ),
    ).toEqual([other]);
    preview.isEnabled.mockClear();
    await access.requireConnection(other, "actor");
    expect(preview.isEnabled).not.toHaveBeenCalled();
  });
  it("propagates storage errors instead of treating them as a normal disabled flag", async () => {
    const { access, preview } = policy(new Set());
    preview.isEnabled.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(access.requireAvailable("gmail", "actor")).rejects.toThrow(
      "database unavailable",
    );
  });
});
