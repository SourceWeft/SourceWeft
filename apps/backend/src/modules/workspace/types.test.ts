import assert from "node:assert/strict";
import { test } from "vitest";
import {
  capGuestRole,
  defaultContentRoleForOrganizationRole,
  isOrganizationAdminRole,
  isWorkspaceRole,
  resolveContentRole,
  workspaceRoleSatisfies,
} from "./types";

test("a guest is never more than an editor", () => {
  assert.equal(capGuestRole("workspace_admin"), "editor");
  assert.equal(capGuestRole("editor"), "editor");
  assert.equal(capGuestRole("viewer"), "viewer");
});

test("workspaceRoleSatisfies ranks admin above editor above viewer", () => {
  assert.equal(workspaceRoleSatisfies("workspace_admin", "viewer"), true);
  assert.equal(workspaceRoleSatisfies("workspace_admin", "editor"), true);
  assert.equal(workspaceRoleSatisfies("editor", "editor"), true);
  assert.equal(workspaceRoleSatisfies("editor", "workspace_admin"), false);
  assert.equal(workspaceRoleSatisfies("viewer", "editor"), false);
  assert.equal(workspaceRoleSatisfies("viewer", "viewer"), true);
});

test("isWorkspaceRole rejects anything outside the three roles", () => {
  assert.equal(isWorkspaceRole("workspace_admin"), true);
  assert.equal(isWorkspaceRole("owner"), false);
  assert.equal(isWorkspaceRole(undefined), false);
});

test("organization owners and admins administer the container", () => {
  assert.equal(isOrganizationAdminRole("owner"), true);
  assert.equal(isOrganizationAdminRole("admin"), true);
  assert.equal(isOrganizationAdminRole("member"), false);
  // better-auth stores multi-role members as a comma-joined string.
  assert.equal(isOrganizationAdminRole("member,admin"), true);
  assert.equal(isOrganizationAdminRole("member, sales"), false);
});

test("default content role follows the organization role", () => {
  assert.equal(
    defaultContentRoleForOrganizationRole("owner"),
    "workspace_admin",
  );
  assert.equal(defaultContentRoleForOrganizationRole("member"), "editor");
});

test("the shared workspace admits every organization member by derivation", () => {
  assert.deepEqual(
    resolveContentRole({
      organizationRole: "member",
      isDefaultWorkspace: true,
      overrideRole: null,
    }),
    { role: "editor", source: "derived" },
  );
});

test("any other workspace is invitation-only", () => {
  assert.deepEqual(
    resolveContentRole({
      organizationRole: "owner",
      isDefaultWorkspace: false,
      overrideRole: null,
    }),
    { role: null, source: null },
  );
});

test("an explicit override wins in both directions", () => {
  // Downgrade: an organization owner made a viewer here is a viewer here.
  assert.deepEqual(
    resolveContentRole({
      organizationRole: "owner",
      isDefaultWorkspace: true,
      overrideRole: "viewer",
    }),
    { role: "viewer", source: "explicit" },
  );

  // Upgrade: a plain member promoted inside one workspace.
  assert.deepEqual(
    resolveContentRole({
      organizationRole: "member",
      isDefaultWorkspace: true,
      overrideRole: "workspace_admin",
    }),
    { role: "workspace_admin", source: "explicit" },
  );

  // And an override is how someone joins a non-shared workspace at all.
  assert.deepEqual(
    resolveContentRole({
      organizationRole: "member",
      isDefaultWorkspace: false,
      overrideRole: "editor",
    }),
    { role: "editor", source: "explicit" },
  );
});
