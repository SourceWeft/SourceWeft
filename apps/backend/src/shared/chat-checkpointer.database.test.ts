import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { Pool } from "pg";
import {
  emptyCheckpoint,
  compareChannelVersions,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";
import { createIsolatedTestDatabase } from "../test/isolated-database";
import {
  UniqueVersionPostgresSaver,
  nextUniqueCheckpointVersion,
} from "./unique-version-postgres-saver";

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let saver: UniqueVersionPostgresSaver;
beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("checkpoint");
  saver = new UniqueVersionPostgresSaver(
    new Pool({ connectionString: isolated.url }),
    undefined,
    { schema: "langgraph" },
  );
  await saver.setup();
}, 90_000);
afterAll(async () => {
  await saver?.end();
  await isolated?.close();
});

test("channel versions advance across legacy numbers and remain unique across branches", () => {
  for (const old of [undefined, 1, 9, 99, 999, 1000, Number.MAX_SAFE_INTEGER]) {
    const a = nextUniqueCheckpointVersion(old);
    const b = nextUniqueCheckpointVersion(old);
    assert.notEqual(a, b);
    if (old !== undefined) {
      assert.ok(compareChannelVersions(a, old) > 0);
      assert.ok((a as unknown as number) > old);
      assert.equal(maxChannelVersion(old, a), a);
    }
    const next = nextUniqueCheckpointVersion(maxChannelVersion(a, b));
    assert.ok(next > a && next > b);
  }
  assert.throws(() => nextUniqueCheckpointVersion("unrecognized-version"));
});

test("PostgreSQL branches from one checkpoint retain their own messages instead of reading the first branch blob", async () => {
  const config = {
    configurable: { thread_id: randomUUID(), checkpoint_ns: "" },
  };
  // Existing numeric checkpoints remain readable without a data migration.
  const base = {
    ...emptyCheckpoint(),
    channel_values: { messages: ["base"] },
    channel_versions: { messages: 99 },
  };
  const baseConfig = await saver.put(
    config,
    base,
    { source: "input", step: 0, parents: {} },
    { messages: 99 },
  );
  const branches = [];
  for (const value of ["branch A", "branch B"]) {
    const version = saver.getNextVersion(base.channel_versions.messages);
    const checkpoint = {
      ...emptyCheckpoint(),
      channel_values: { messages: [value] },
      channel_versions: { messages: version },
    };
    const saved = await saver.put(
      baseConfig,
      checkpoint,
      { source: "loop", step: 1, parents: {} },
      { messages: version },
    );
    branches.push({ saved, value });
  }
  for (const { saved, value } of branches) {
    assert.deepEqual(
      (await saver.getTuple(saved))?.checkpoint.channel_values.messages,
      [value],
    );
  }
  assert.deepEqual(
    (await saver.getTuple(baseConfig))?.checkpoint.channel_values.messages,
    ["base"],
  );
});
