import assert from "node:assert/strict";
import { test } from "node:test";
import { createVolumeHooks } from "../src/hooks/index";
import type { VolumeService } from "../src/service/volume-service";

const marker = (report: unknown, code = 0) =>
  `user output\n__SWVOL__ ${code} ${JSON.stringify(report)}\n`;
function fixture(
  options: {
    head?: number;
    walRejected?: string | null;
    rebaseOutput?: string;
    rebaseExit?: number;
    noVolume?: boolean;
    noAttachment?: boolean;
    checkpointOutput?: string;
    checkpointExit?: number;
  } = {},
) {
  let applications = 0;
  const service = {
    repo: {
      getAttachment: async () => ({ id: "att-test", volumeId: "vol-test" }),
      head: async () => options.head ?? 1,
      findVolume: async () => (options.noVolume ? null : { id: "vol-test" }),
      activeAttachment: async () =>
        options.noAttachment
          ? null
          : { id: "att-test", volumeId: "vol-test", sandboxId: "sandbox-test" },
    },
    confirmPersistence: async (_id: string, seq: number) =>
      (options.head ?? 1) >= seq,
    applyWal: async () => {
      applications++;
      return {
        applied: 0,
        entries: [],
        rejected: applications === 1 ? (options.walRejected ?? null) : null,
      };
    },
    beginRebase: async () => ({
      slotsUrl: "https://example.invalid/test",
      head: 0,
    }),
  } as unknown as VolumeService;
  const executor = {
    execute: async () => ({
      output:
        options.rebaseOutput ??
        options.checkpointOutput ??
        '{"ok":true,"seq":1}',
      exitCode: options.rebaseExit ?? options.checkpointExit ?? 0,
    }),
  };
  const hooks = createVolumeHooks({
    service,
    helper: { imagePath: "/usr/local/sbin/swvol" },
  });
  const parse = (output: string, exitCode: number | null = 0) =>
    hooks.parseResult({ attachmentId: "att-test", output, exitCode, executor });
  return { hooks, parse, executor, applications: () => applications };
}
const unconfirmed = (error: unknown) =>
  (error as { code?: string })?.code ===
  "SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED";
for (const [name, output] of [
  ["missing marker", "user output"],
  ["malformed JSON", "user output\n__SWVOL__ 0 broken\n"],
  ["missing explicit success", marker({ seq: 1 })],
  ["missing sequence", marker({ ok: true })],
  ["negative sequence", marker({ ok: true, seq: -1 })],
  ["failed flush", marker({ ok: false, seq: 1 })],
  ["unsuccessful flush exit", marker({ ok: true, seq: 1 }, 1)],
] as const)
  test(`durability rejects ${name}`, async () => {
    await assert.rejects(fixture().parse(output), unconfirmed);
  });
test("helper sequence ahead of applied database head cannot be acknowledged", async () => {
  await assert.rejects(
    fixture({ head: 0 }).parse(marker({ ok: true, seq: 1 })),
    unconfirmed,
  );
});
test("user exit 75 is preserved after a confirmed flush, without container-replaced classification", async () => {
  const result = await fixture().parse(marker({ ok: true, seq: 1 }), 75);
  assert.equal(result.exitCode, 75);
  assert.equal(result.sync.persisted, true);
});
test("printed replacement marker with a successful process exit is not safe to replay", async () => {
  const f = fixture();
  await assert.rejects(f.parse(marker({}, 75), 0), unconfirmed);
});
test("no completed provider exit cannot be acknowledged", async () => {
  await assert.rejects(
    fixture().parse(marker({ ok: true, seq: 1 }), null),
    unconfirmed,
  );
});
test("volume without an active attachment cannot be treated as no volume on cleanup", async () => {
  const f = fixture({ noAttachment: true });
  await assert.rejects(
    f.hooks.checkpointScope({
      scope: { teamId: "t", workspaceId: "w", threadId: "r" },
      sandboxId: "sandbox-test",
      executor: f.executor,
    }),
    unconfirmed,
  );
});
test("cleanup without a thread volume remains a no-op", async () => {
  const f = fixture({ noVolume: true });
  assert.equal(
    await f.hooks.checkpointScope({
      scope: { teamId: "t", workspaceId: "w", threadId: "r" },
      sandboxId: "sandbox-test",
      executor: f.executor,
    }),
    null,
  );
});
test("a replacement during checkpoint does not permit cleanup", async () => {
  const f = fixture({
    checkpointOutput: "\n__SWVOL__ 75 {}\n",
    checkpointExit: 75,
  });
  await assert.rejects(
    f.hooks.checkpointScope({
      scope: { teamId: "t", workspaceId: "w", threadId: "r" },
      sandboxId: "sandbox-test",
      executor: f.executor,
    }),
    unconfirmed,
  );
});
test("a successful rebase must prove its new flush sequence in the database", async () => {
  const f = fixture({
    walRejected: "invalid manifest",
    rebaseOutput: '{"ok":true,"seq":1}',
    head: 1,
  });
  const result = await f.parse(marker({ ok: true, seq: 1 }));
  assert.equal(result.sync.persisted, true);
  assert.equal(f.applications(), 2);
});
test("a failed or malformed rebase remains unconfirmed", async () => {
  for (const options of [{ rebaseExit: 1 }, { rebaseOutput: "not-json" }]) {
    await assert.rejects(
      fixture({ walRejected: "invalid manifest", ...options }).parse(
        marker({ ok: true, seq: 1 }),
      ),
      unconfirmed,
    );
  }
});

test("malformed replacement arrays are unconfirmed, never safe to replay", async () => {
  await assert.rejects(fixture().parse("\n__SWVOL__ 75 []\n", 75), unconfirmed);
});

test("even a well-formed replacement marker cannot prove the user command never ran", async () => {
  await assert.rejects(fixture().parse("\n__SWVOL__ 75 {}\n", 75), unconfirmed);
});

test("host preflight distinguishes a changed boot from missing helper state", async () => {
  const oldBoot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const newBoot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const service = {
    assertAttachmentActive: async () => undefined,
    repo: { getAttachment: async () => ({ id: "a", bootId: oldBoot }) },
  } as unknown as VolumeService;
  const hooks = createVolumeHooks({ service, helper: { imagePath: "/swvol" } });
  const probe = (boot: string, exitCode: number) =>
    hooks.assertActive({
      attachmentId: "a",
      executor: {
        execute: async () => ({ output: `__SWVOL_BOOT__ ${boot}\n`, exitCode }),
      },
    });
  await probe(oldBoot, 0);
  await assert.rejects(probe(oldBoot, 75), unconfirmed);
  await assert.rejects(probe("", 79), unconfirmed);
  await assert.rejects(probe(newBoot, 75), unconfirmed);
});

test("malformed unreadable and skipped diagnostics never confirm a barrier", async () => {
  for (const extra of [
    { unreadable: "pack" },
    { skipped: ["unreadable-file"] },
    { unstable: 1 },
  ])
    await assert.rejects(
      fixture().parse(marker({ ok: true, seq: 1, ...extra })),
      unconfirmed,
    );
});
test("checkpoint cannot use a different sandbox executor for the current attachment", async () => {
  const f = fixture();
  await assert.rejects(
    f.hooks.checkpointScope({
      scope: { teamId: "t", workspaceId: "w", threadId: "r" },
      sandboxId: "old-sandbox",
      executor: f.executor,
    }),
    /different sandbox/,
  );
  assert.equal(f.applications(), 0);
});
test("persistence error retains the original command result without its control marker", async () => {
  try {
    await fixture().parse(marker({ ok: false, seq: 1 }), 17);
    assert.fail("must throw");
  } catch (error) {
    assert.ok(unconfirmed(error));
    assert.equal((error as { commandExitCode?: number }).commandExitCode, 17);
    assert.equal(
      (error as { commandOutput?: string }).commandOutput,
      "user output",
    );
  }
});
test("slots can be renewed and the barrier retried without re-running the command", async () => {
  const commands: string[] = [];
  const service = {
    repo: { getAttachment: async () => ({ id: "att", status: "active" }) },
    applyWal: async () => ({ applied: 1, entries: [], rejected: null }),
    publishSlots: async () => "https://example.invalid/slots",
    confirmPersistence: async (_id: string, seq: number) => seq === 2,
  } as unknown as VolumeService;
  const hooks = createVolumeHooks({ service, helper: { imagePath: "/swvol" } });
  const result = await hooks.parseResult({
    attachmentId: "att",
    output: marker({ ok: false, exit_code: 76 }, 76),
    exitCode: 7,
    executor: {
      execute: async (command) => {
        commands.push(command);
        return { exitCode: 0, output: '{"ok":true,"seq":2}' };
      },
    },
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.sync.confirmedSeq, 2);
  assert.equal(commands.length, 1);
  assert.match(commands[0]!, /flush/);
  assert.doesNotMatch(commands[0]!, /eval/);
});
