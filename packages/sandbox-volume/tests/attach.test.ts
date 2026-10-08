import assert from "node:assert/strict";
import { test } from "node:test";
import { createVolumeHooks } from "../src/hooks/index";
import type { VolumeService } from "../src/service/volume-service";

const scope = { teamId: "t", workspaceId: "w", threadId: "r" };
function fixture(
  options: {
    shadow?: boolean;
    previous?: Record<string, unknown>;
    output?: string;
    exitCode?: number;
  } = {},
) {
  const scopes: Array<Record<string, unknown>> = [];
  const commands: string[] = [];
  const replacements: unknown[] = [];
  let binds = 0;
  const service = {
    repo: {
      activeAttachment: async () => options.previous ?? null,
      findVolume: async () => ({ id: "v" }),
    },
    getOrCreateVolume: async (value: Record<string, unknown>) => {
      scopes.push(value);
      return { id: "v" };
    },
    attach: async (_id: string, _sandbox: string, replacement: unknown) => {
      binds++;
      replacements.push(replacement);
      return { id: "a", volumeId: "v" };
    },
    publishAttachFiles: async () => ({
      planUrl: "https://example.invalid/plan",
      slotsUrl: "https://example.invalid/slots",
    }),
    recordBootId: async () => undefined,
    assertAttachmentActive: async () => undefined,
    applyWal: async () => ({ applied: 0, entries: [], rejected: null }),
  } as unknown as VolumeService;
  const executor = {
    execute: async (command: string) => {
      commands.push(command);
      return {
        exitCode: options.exitCode ?? 0,
        output: options.output ?? '{"ok":true,"boot_id":"boot"}\nDAEMON_UP\n',
      };
    },
  };
  const hooks = createVolumeHooks({
    service,
    helper: { imagePath: "/swvol" },
    shadow: options.shadow,
  });
  return {
    hooks,
    executor,
    scopes,
    commands,
    replacements,
    binds: () => binds,
  };
}
test("each shadow attach has its own namespace and never targets the primary volume", async () => {
  const f = fixture({ shadow: true });
  await f.hooks.attach({ scope, sandboxId: "s1", executor: f.executor });
  await f.hooks.attach({ scope, sandboxId: "s2", executor: f.executor });
  assert.match(String(f.scopes[0]!.namespace), /^shadow:/);
  assert.notEqual(f.scopes[0]!.namespace, f.scopes[1]!.namespace);
});
test("a healthy attachment resumes without restore or killing its daemon", async () => {
  const f = fixture({
    previous: { id: "old", sandboxId: "s", bootId: "boot" },
  });
  const result = await f.hooks.attach({
    scope,
    sandboxId: "s",
    executor: f.executor,
  });
  assert.equal(result.attachmentId, "old");
  assert.equal(f.binds(), 0);
  assert.equal(f.commands.length, 1);
  assert.doesNotMatch(f.commands[0]!, /restore|kill/);
});
test("a different active sandbox cannot be silently replaced by attach", async () => {
  const f = fixture({
    previous: { id: "old", sandboxId: "s1", bootId: "boot" },
  });
  await assert.rejects(
    f.hooks.attach({ scope, sandboxId: "s2", executor: f.executor }),
    /explicit recovery/,
  );
  assert.equal(f.binds(), 0);
});
test("an explicit replacement must match the previous sandbox and uses attachment CAS", async () => {
  const f = fixture({
    previous: { id: "old", sandboxId: "s1", bootId: "boot" },
  });
  await assert.rejects(
    f.hooks.onContainerReplaced({
      scope,
      sandboxId: "s2",
      previousSandboxId: "wrong",
      executor: f.executor,
    }),
    /previous active/,
  );
  await f.hooks.onContainerReplaced({
    scope,
    sandboxId: "s2",
    previousSandboxId: "s1",
    executor: f.executor,
  });
  assert.deepEqual(f.replacements, [{ expectedAttachmentId: "old" }]);
});
test("attach requires explicit restore success, identity and daemon readiness", async () => {
  for (const output of [
    '{"ok":true,"boot_id":"boot"}\nDAEMON_DOWN\n',
    '{"ok":true}\nDAEMON_UP\n',
    '{"ok":false,"boot_id":"boot"}\nDAEMON_UP\n',
  ]) {
    const f = fixture({ output });
    await assert.rejects(
      f.hooks.attach({ scope, sandboxId: "s", executor: f.executor }),
      /attach did not prove/,
    );
  }
});
