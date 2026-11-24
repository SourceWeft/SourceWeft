import { expect, test, vi } from "vitest";
import type { WorkspaceMember } from "@sourceweft/contracts";

vi.mock("./sdk", () => ({ assistantClient: {}, workspaceClient: {} }));

import { viewerStanding } from "./assistant";

function member(
  userId: string,
  organizationRole: string,
  role: WorkspaceMember["role"] = "editor",
): WorkspaceMember {
  return {
    workspaceId: "ws_1",
    userId,
    role,
    source: "derived",
    organizationRole,
    name: userId,
    email: null,
    image: null,
  };
}

const members = [
  member("owner", "owner", "workspace_admin"),
  member("admin", "admin", "workspace_admin"),
  member("multi", "member,admin"),
  member("editor", "member", "editor"),
  member("viewer", "member", "viewer"),
];

test("organization owners and admins are workspace admins, including in a multi-role string", () => {
  expect(viewerStanding(members, "owner")).toEqual({
    isAdmin: true,
    canWrite: true,
  });
  expect(viewerStanding(members, "admin")).toEqual({
    isAdmin: true,
    canWrite: true,
  });
  expect(viewerStanding(members, "multi").isAdmin).toBe(true);
});

test("a plain member is no admin; an editor can write, a viewer cannot", () => {
  expect(viewerStanding(members, "editor")).toEqual({
    isAdmin: false,
    canWrite: true,
  });
  expect(viewerStanding(members, "viewer")).toEqual({
    isAdmin: false,
    canWrite: false,
  });
});

test("a viewer missing from the list, or not signed in, gets nothing", () => {
  expect(viewerStanding(members, "stranger")).toEqual({
    isAdmin: false,
    canWrite: false,
  });
  expect(viewerStanding(members, null)).toEqual({
    isAdmin: false,
    canWrite: false,
  });
  expect(viewerStanding(undefined, "owner")).toEqual({
    isAdmin: false,
    canWrite: false,
  });
});
