import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** Explicitly invoked cloud experiment. Never selects existing sandbox IDs. */
export function sessionProbeEnv(): Record<string, string> {
  if (process.env.SANDBOX_SESSION_PROBE !== "1")
    throw new Error("SANDBOX_SESSION_PROBE=1 is required");
  const file = process.env.SANDBOX_SESSION_PROBE_ENV_FILE;
  if (!file)
    throw new Error(
      "SANDBOX_SESSION_PROBE_ENV_FILE must explicitly select credentials",
    );
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  return env;
}

export type SessionProbeDriver = {
  provider: string;
  createSandbox(purpose: string): Promise<void>;
  createSession(id: string): Promise<void>;
  execute(
    command: string,
    sessionId?: string,
  ): Promise<{ output: string; exitCode: number | null }>;
  deleteSession(id: string): Promise<void>;
  deleteSandbox(): Promise<void>;
};

export async function probeSessionCancellation(
  driver: SessionProbeDriver,
): Promise<void> {
  const nonce = randomUUID();
  const root = `/workspace/swvol-cancel-probe-${nonce}`;
  const first = `swvol-a-${nonce}`;
  const sibling = `swvol-b-${nonce}`;
  let created = false;
  const running: Promise<unknown>[] = [];
  const expectExec = async (command: string, session?: string) => {
    const result = await driver.execute(command, session);
    assert.equal(result.exitCode, 0, "probe command must succeed");
    return result.output.trim();
  };
  const counts = async (): Promise<number[]> =>
    JSON.parse(
      await expectExec(
        `python3 -c 'import json,pathlib; p=pathlib.Path("${root}"); print(json.dumps([len((p/n).read_text().splitlines()) if (p/n).exists() else 0 for n in ["parent","child","sibling"]]))'`,
      ),
    );
  try {
    await driver.createSandbox(`sandbox-volume-session-cancellation-${nonce}`);
    created = true;
    await expectExec(
      `mkdir -p ${root}; printf durable-sentinel > ${root}/sentinel`,
    );
    await driver.createSession(first);
    await driver.createSession(sibling);
    const loop = (name: string) =>
      `while :; do echo tick >> ${root}/${name}; sleep 0.2; done`;
    // Keep both command requests alive while deleting just the first session.
    running.push(
      driver
        .execute(`(${loop("child")}) & ${loop("parent")}`, first)
        .catch(() => undefined),
    );
    running.push(
      driver.execute(loop("sibling"), sibling).catch(() => undefined),
    );
    const deadline = Date.now() + 30_000;
    let before = await counts();
    while (before.some((value) => value < 3) && Date.now() < deadline) {
      await sleep(500);
      before = await counts();
    }
    assert.ok(
      before.every((value) => value >= 3),
      "all three writers must start",
    );
    await driver.deleteSession(first);
    await sleep(1000);
    const stopped = await counts();
    await sleep(1500);
    const later = await counts();
    assert.equal(later[0], stopped[0], "deleted session parent must stop");
    assert.equal(later[1], stopped[1], "deleted session child must stop");
    assert.ok(later[2]! > stopped[2]!, "sibling session must remain alive");
    assert.equal(await expectExec(`cat ${root}/sentinel`), "durable-sentinel");
    await driver.deleteSession(sibling);
    const background = `swvol-bg-${nonce}`;
    await driver.createSession(background);
    await expectExec(
      `sh -c '${loop("background")}' >/dev/null 2>&1 & echo launched`,
      background,
    );
    const backgroundCount = async () =>
      Number(await expectExec(`wc -l < ${root}/background`));
    await sleep(500);
    const bgBefore = await backgroundCount();
    await sleep(1000);
    assert.ok(
      (await backgroundCount()) > bgBefore,
      "background child must survive normal command completion",
    );
    await driver.deleteSession(background);
    await sleep(500);
    const bgStopped = await backgroundCount();
    await sleep(1000);
    assert.equal(
      await backgroundCount(),
      bgStopped,
      "cancel must terminate a completed command's background child",
    );
    console.log(
      JSON.stringify({
        provider: driver.provider,
        test: "session-cancellation",
        parentStopped: true,
        childStopped: true,
        siblingSurvived: true,
        diskPreserved: true,
        backgroundSurvivesCompletion: true,
        backgroundStopsOnCancel: true,
      }),
    );
  } finally {
    // Delete only the new disposable sandbox allocated by this invocation.
    if (created) await driver.deleteSandbox();
    await Promise.race([Promise.allSettled(running), sleep(5000)]);
  }
}
