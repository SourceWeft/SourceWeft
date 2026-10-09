import assert from "node:assert/strict";
import { test } from "node:test";
import { createVolumeHooks } from "../src/hooks/index";
import type { CaptureProgress } from "../src/protocol/types";
import type { VolumeService } from "../src/service/volume-service";

function progress(window: number, base = 0): CaptureProgress {
  return {
    v: 1,
    volume: "vol",
    attachment: "att",
    boot_id: "boot",
    epoch: base === 0 ? 0 : 1,
    base_seq: base,
    next_pack: window * 64,
    uploaded_packs: window * 64,
    uploaded_chunks: window * 64,
    uploaded_raw_bytes: window * 64 * 1024,
    receipt_digest: window.toString(16).padStart(64, "0"),
    recent_uploaded_pack_numbers: Array.from(
      { length: 64 },
      (_, i) => (window - 1) * 64 + i,
    ),
  };
}
const marker = (report: unknown) =>
  `ORIGINAL_COMMAND_ALREADY_RAN\n__SWVOL__ 76 ${JSON.stringify(report)}\n`;
const unconfirmed = (error: unknown) =>
  (error as { code?: string })?.code ===
  "SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED";

function fixture({
  windows = 8,
  legacy = false,
  rebase = false,
  reject = false,
  confirm = true,
  slotTaken = false,
  drainId = undefined as string | undefined,
  onApply = (_count: number) => {},
} = {}) {
  let returned: CaptureProgress | undefined;
  let renews = 0;
  let legacyRenews = 0;
  let applies = 0;
  let confirmations = 0;
  let rebaseStarted = false;
  let rebases = 0;
  const publishSignals: Array<AbortSignal | undefined> = [];
  const commands: string[] = [];
  const timeouts: number[] = [];
  const base = rebase ? 17 : 0;
  const service = {
    repo: {
      getAttachment: async () => ({
        id: "att",
        volumeId: "vol",
        status: drainId ? "draining" : "active",
        drainId,
      }),
    },
    publishSlots: async (
      _actor: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      publishSignals.push(options?.signal);
      legacyRenews++;
      return "https://example.invalid/slots";
    },
    renewCaptureSlots: async (
      _id: string,
      p: CaptureProgress,
      previous?: CaptureProgress,
    ) => {
      if (reject) throw new Error("object progress is not corroborated");
      assert.equal(
        previous,
        returned,
        "the original verified proof object must be passed back",
      );
      assert.equal(p.base_seq, base);
      returned = Object.freeze({ ...p });
      renews++;
      return {
        slotsUrl: "https://example.invalid/slots",
        progress: returned,
        verifiedObjectBytes: 64 * 1024,
      };
    },
    applyWal: async () => {
      applies++;
      onApply(applies);
      return {
        applied: 0,
        entries: [],
        rejected: rebase && !slotTaken && applies === 1 ? "rejected" : null,
      };
    },
    beginRebase: async (_id: string, options?: { drainId?: string }) => {
      assert.equal(options?.drainId, drainId);
      rebases++;
      rebaseStarted = true;
      return { slotsUrl: "https://example.invalid/slots", head: base };
    },
    confirmPersistence: async (_id: string, seq: number) => {
      confirmations++;
      assert.equal(seq, base + 1);
      return confirm;
    },
  } as unknown as VolumeService;
  const hooks = createVolumeHooks({ service, helper: { imagePath: "/swvol" } });
  const executor = {
    execute: async (command: string, options: { timeoutMs: number }) => {
      commands.push(command);
      timeouts.push(options.timeoutMs);
      assert.ok(
        !command.includes("ORIGINAL_COMMAND_ALREADY_RAN"),
        "user command must never be replayed",
      );
      if (rebaseStarted)
        assert.ok(
          command.endsWith(`--rebase ${base}`),
          "every retry must preserve the authoritative rebase head",
        );
      if (rebase && commands.length === 1)
        return {
          output: JSON.stringify({
            ok: false,
            exit_code: 76,
            capture_progress: progress(1, base),
          }),
          exitCode: 76,
        };
      if (legacy)
        return { output: '{"ok":false,"exit_code":76}', exitCode: 76 };
      if (renews < windows)
        return {
          output: JSON.stringify({
            ok: false,
            exit_code: 76,
            capture_progress: progress(renews + 1, base),
          }),
          exitCode: 76,
        };
      return {
        output: JSON.stringify({ ok: true, seq: base + 1 }),
        exitCode: 0,
      };
    },
  };
  const initial = rebase
    ? slotTaken
      ? { ok: false, error: "MANIFEST_SLOT_TAKEN: occupied", seq: 0 }
      : { ok: true, seq: 0 }
    : legacy
      ? { ok: false, exit_code: 76 }
      : { ok: false, exit_code: 76, capture_progress: progress(1) };
  const run = () =>
    hooks.parseResult({
      attachmentId: "att",
      output: rebase
        ? `ORIGINAL_COMMAND_ALREADY_RAN\n__SWVOL__ 0 ${JSON.stringify(initial)}\n`
        : marker(initial),
      exitCode: 0,
      executor,
      drainId,
    });
  return {
    run,
    rebases: () => rebases,
    publishSignals,
    commands,
    timeouts,
    renews: () => renews,
    legacyRenews: () => legacyRenews,
    confirmations: () => confirmations,
  };
}

test("eight physically verified upload windows finish without replaying the command or acknowledging partial files", async () => {
  const f = fixture();
  const r = await f.run();
  assert.equal(f.renews(), 8);
  assert.equal(f.confirmations(), 1);
  assert.equal(r.output, "ORIGINAL_COMMAND_ALREADY_RAN");
  assert.equal(r.sync.persisted, true);
  assert.ok(f.timeouts.every((ms) => ms > 0 && ms <= 600_000));
});
test("unverified or forged capture evidence never extends slots or dispatches another barrier", async () => {
  const f = fixture({ reject: true });
  await assert.rejects(f.run(), unconfirmed);
  assert.equal(f.commands.length, 0);
  assert.equal(f.legacyRenews(), 0);
  assert.equal(f.confirmations(), 0);
});
test("absent progress retains the old three-renewal bound and never confirms", async () => {
  const f = fixture({ legacy: true });
  await assert.rejects(f.run(), unconfirmed);
  assert.equal(f.legacyRenews(), 3);
  assert.equal(f.commands.length, 3);
  assert.equal(f.confirmations(), 0);
});
test("progress cannot evade the 32-window operation bound", async () => {
  const f = fixture({ windows: 33 });
  await assert.rejects(f.run(), unconfirmed);
  assert.equal(f.renews(), 32);
  assert.equal(f.confirmations(), 0);
});
test("large explicit rebase keeps its head across every upload window", async () => {
  const f = fixture({ rebase: true, windows: 5 });
  const r = await f.run();
  assert.equal(f.renews(), 5);
  assert.equal(r.sync.persisted, true);
  assert.equal(r.sync.confirmedSeq, 18);
});
test("complete helper upload still requires an independent database acknowledgement", async () => {
  const f = fixture({ confirm: false });
  await assert.rejects(f.run(), unconfirmed);
  assert.equal(f.confirmations(), 1);
});
test("the aggregate deadline applies before any additional grant", async (t) => {
  let reads = 0;
  t.mock.method(performance, "now", () => (reads++ === 0 ? 0 : 1_800_001));
  const f = fixture();
  await assert.rejects(f.run(), unconfirmed);
  assert.equal(f.renews(), 0);
  assert.equal(f.commands.length, 0);
});

for (const slotTaken of [false, true]) {
  test(`expired ${slotTaken ? "occupied manifest" : "rejected WAL"} cannot advance epoch or publish rebase slots`, async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const f = fixture({
      rebase: true,
      slotTaken,
      onApply: () => {
        now = 1_800_001;
      },
    });
    await assert.rejects(f.run(), unconfirmed);
    assert.equal(f.rebases(), 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.confirmations(), 0);
  });
}
test("rebase retains the caller's drain fence", async () => {
  const f = fixture({ rebase: true, windows: 1, drainId: "drain-test" });
  assert.equal((await f.run()).sync.persisted, true);
  assert.equal(f.rebases(), 1);
});
test("legacy publication receives the current recovery deadline signal", async () => {
  const f = fixture({ legacy: true });
  await assert.rejects(f.run(), unconfirmed);
  assert.equal(f.publishSignals.length, 3);
  assert.ok(
    f.publishSignals.every(
      (signal) => signal instanceof AbortSignal && !signal.aborted,
    ),
  );
});
test("a WAL response after the aggregate deadline cannot start confirmation", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture({
    windows: 1,
    onApply: (count) => {
      if (count === 2) now = 1_800_001;
    },
  });
  await assert.rejects(f.run(), unconfirmed);
  assert.equal(f.commands.length, 1);
  assert.equal(f.confirmations(), 0);
});
