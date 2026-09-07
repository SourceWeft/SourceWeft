import { randomBytes } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

// Postgres stores channel blobs by (thread, namespace, channel, version), not
// checkpoint id. The base saver's integer increment collides when two branches
// continue from the same checkpoint; ON CONFLICT then retains the first branch.
// Decimal-only string versions work with LangGraph's string comparisons and
// its mixed numeric/string comparisons while old numeric checkpoints remain.
// Any legacy safe integer has at most 16 decimal digits. A prefix of 16 nines
// sorts after all of them (including e.g. 99) in lexicographic comparisons,
// and the decimal value also exceeds them in mixed-type `>` comparisons.
const FIRST_STRING_VERSION = BigInt("99999999999999990000000000000000");
const MAX_STRING_VERSION = BigInt("99999999999999999999999999999999");

export function nextUniqueCheckpointVersion(
  current: number | string | undefined,
): string {
  let next = FIRST_STRING_VERSION;
  if (typeof current === "string") {
    if (!/^\d{32}\.\d{39}$/.test(current)) {
      throw new Error("Unsupported persisted checkpoint channel version");
    }
    next = BigInt(current.split(".")[0]!) + 1n;
  } else if (
    current !== undefined &&
    (!Number.isSafeInteger(current) || current < 0)
  ) {
    throw new Error("Invalid numeric checkpoint channel version");
  }
  if (next < FIRST_STRING_VERSION || next > MAX_STRING_VERSION) {
    throw new Error("Checkpoint channel version range exhausted");
  }
  // Every branch advances the counter and receives an independent 128-bit
  // nonce. Keep 32 counter digits so string order matches counter order.
  const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`)
    .toString()
    .padStart(39, "0");
  return `${next}.${nonce}`;
}

export class UniqueVersionPostgresSaver extends PostgresSaver {
  // Upstream PostgresSaver fixes its TS generic to number, although its SQL
  // and LangGraph both support string ChannelVersions. Confine that upstream
  // typing mismatch to this adapter; exercise the real saver in PostgreSQL.
  override getNextVersion =
    nextUniqueCheckpointVersion as unknown as PostgresSaver["getNextVersion"];
}
