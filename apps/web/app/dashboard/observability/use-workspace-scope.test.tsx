// @vitest-environment jsdom
import assert from "node:assert/strict";
import { act, createElement, useEffect } from "react";
import { afterEach, test } from "vitest";
import { mount, unmountAll } from "@/test/react";
import {
  ALL_WORKSPACES,
  useObservabilityWorkspaceScope,
} from "./use-workspace-scope";

type Input = Parameters<typeof useObservabilityWorkspaceScope>[0];
let select: (scope: string) => void;
let observed: Array<{ organizationId: string | null; scope: string | null }> =
  [];
function Probe(props: Input) {
  const [scope, setScope] = useObservabilityWorkspaceScope(props);
  select = setScope;
  // Mirrors the loading effects: every committed scope would issue a request.
  useEffect(() => {
    observed.push({ organizationId: props.organizationId, scope });
  }, [props.organizationId, scope]);
  return createElement("output", null, scope);
}
const team = (name: string): Input => ({
  organizationId: name,
  workspaceId: `${name}-1`,
  workspaces: [{ id: `${name}-1` }, { id: `${name}-2` }],
});
afterEach(async () => {
  await unmountAll();
  observed = [];
});

test("switching organizations never commits a request with the old workspace", async () => {
  const view = await mount(createElement(Probe, team("a")));
  await act(async () => select("a-2"));
  await view.render(createElement(Probe, team("b")));
  assert.deepEqual(observed, [
    { organizationId: "a", scope: "a-1" },
    { organizationId: "a", scope: "a-2" },
    { organizationId: "b", scope: "b-1" },
  ]);
  await view.render(createElement(Probe, team("a")));
  assert.deepEqual(observed.at(-1), { organizationId: "a", scope: "a-1" });
});

test("a loading organization cannot use a workspace outside its catalog", async () => {
  const view = await mount(createElement(Probe, team("a")));
  await view.render(
    createElement(Probe, {
      organizationId: "b",
      workspaceId: "a-1",
      workspaces: [],
    }),
  );
  assert.deepEqual(observed.at(-1), {
    organizationId: "b",
    scope: ALL_WORKSPACES,
  });
  await view.render(
    createElement(Probe, {
      organizationId: null,
      workspaceId: null,
      workspaces: [],
    }),
  );
  assert.deepEqual(observed.at(-1), { organizationId: null, scope: null });
});

test("same-team rerenders preserve a deliberate workspace or all-workspaces filter", async () => {
  const view = await mount(createElement(Probe, team("a")));
  await act(async () => select("a-2"));
  await view.render(createElement(Probe, team("a")));
  assert.equal(observed.at(-1)?.scope, "a-2");
  await act(async () => select(ALL_WORKSPACES));
  await view.render(createElement(Probe, team("a")));
  assert.equal(observed.at(-1)?.scope, ALL_WORKSPACES);
});

test("removing the selected workspace falls back to the current valid workspace", async () => {
  const view = await mount(createElement(Probe, team("a")));
  await act(async () => select("a-2"));
  await view.render(
    createElement(Probe, { ...team("a"), workspaces: [{ id: "a-1" }] }),
  );
  assert.equal(observed.at(-1)?.scope, "a-1");
});
