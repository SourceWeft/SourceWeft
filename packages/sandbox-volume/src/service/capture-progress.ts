import {
  MAX_CHUNK_RAW_BYTES,
  PACK_SLOTS_PER_ISSUE,
} from "../protocol/constants";
import type { CaptureProgress } from "../protocol/types";
import type { VolumeLimits } from "./quota";

export const MAX_CAPTURE_PACK_BYTES = 64 * 1024 * 1024;
export class CaptureProgressRejected extends Error {
  override readonly name = "CaptureProgressRejected";
}
const fields = [
  "v",
  "volume",
  "attachment",
  "boot_id",
  "epoch",
  "base_seq",
  "next_pack",
  "uploaded_packs",
  "uploaded_chunks",
  "uploaded_raw_bytes",
  "receipt_digest",
  "recent_uploaded_pack_numbers",
] as const;
const counters = [
  "epoch",
  "base_seq",
  "next_pack",
  "uploaded_packs",
  "uploaded_chunks",
  "uploaded_raw_bytes",
] as const;
function reject(): never {
  throw new CaptureProgressRejected("invalid capture progress metadata");
}
/** Copy only data properties: callers cannot mutate the identity while HEAD awaits. */
export function parseCaptureProgress(
  value: unknown,
  limits: VolumeLimits,
): CaptureProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key as (typeof fields)[number]))
  )
    reject();
  const record: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) reject();
    record[key] = descriptor.value;
  }
  if (record.v !== 1) reject();
  for (const key of ["volume", "attachment", "boot_id"] as const) {
    const field = record[key];
    if (
      typeof field !== "string" ||
      field.length < 1 ||
      field.length > 256 ||
      field.includes("\0")
    )
      reject();
  }
  for (const key of counters) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0)
      reject();
  }
  if (
    typeof record.receipt_digest !== "string" ||
    !/^[0-9a-f]{64}$/i.test(record.receipt_digest)
  )
    reject();
  if (!Array.isArray(record.recent_uploaded_pack_numbers)) reject();
  const supplied = record.recent_uploaded_pack_numbers;
  if (
    supplied.length !==
      Math.min(record.uploaded_packs as number, PACK_SLOTS_PER_ISSUE) ||
    Reflect.ownKeys(supplied).length !== supplied.length + 1
  )
    reject();
  const numbers: number[] = [];
  for (let i = 0; i < supplied.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(supplied, String(i));
    if (!descriptor || !("value" in descriptor)) reject();
    const n = descriptor.value;
    if (
      !Number.isSafeInteger(n) ||
      n < 0 ||
      n >= (record.next_pack as number) ||
      (i > 0 && n <= numbers[i - 1]!)
    )
      reject();
    numbers.push(n);
  }
  record.recent_uploaded_pack_numbers = numbers;
  Object.freeze(record.recent_uploaded_pack_numbers);
  const progress = record as unknown as CaptureProgress;
  if (
    progress.next_pack < 1 ||
    progress.next_pack > 1_000_000 ||
    progress.uploaded_packs < 1 ||
    progress.uploaded_packs > progress.next_pack ||
    progress.uploaded_chunks < progress.uploaded_packs ||
    progress.uploaded_raw_bytes < progress.uploaded_chunks ||
    progress.uploaded_raw_bytes > limits.maxLogicalBytes ||
    progress.uploaded_packs > limits.maxObjectBytes ||
    BigInt(progress.uploaded_raw_bytes) >
      BigInt(progress.uploaded_chunks) * BigInt(MAX_CHUNK_RAW_BYTES)
  )
    reject();
  return Object.freeze({
    ...progress,
    receipt_digest: progress.receipt_digest.toLowerCase(),
  });
}

export function captureWindow(
  progress: CaptureProgress,
  previous?: CaptureProgress,
): number[] {
  if (!previous) return progress.recent_uploaded_pack_numbers;
  if (
    ["volume", "attachment", "boot_id", "epoch", "base_seq"].some(
      (key) =>
        progress[key as keyof CaptureProgress] !==
        previous[key as keyof CaptureProgress],
    )
  )
    throw new CaptureProgressRejected("capture progress scope changed");
  const packs = progress.uploaded_packs - previous.uploaded_packs;
  const chunks = progress.uploaded_chunks - previous.uploaded_chunks;
  const raw = progress.uploaded_raw_bytes - previous.uploaded_raw_bytes;
  const advance = progress.next_pack - previous.next_pack;
  const added = progress.recent_uploaded_pack_numbers.filter(
    (n) => n >= previous.next_pack,
  );
  if (
    advance < 1 ||
    packs < 1 ||
    packs > PACK_SLOTS_PER_ISSUE ||
    packs > advance ||
    added.length !== packs ||
    chunks < packs ||
    raw < chunks ||
    BigInt(raw) > BigInt(chunks) * BigInt(MAX_CHUNK_RAW_BYTES) ||
    progress.receipt_digest === previous.receipt_digest
  )
    throw new CaptureProgressRejected(
      "capture progress did not advance consistently",
    );
  const expectedTail = [
    ...previous.recent_uploaded_pack_numbers,
    ...added,
  ].slice(-PACK_SLOTS_PER_ISSUE);
  if (
    expectedTail.length !== progress.recent_uploaded_pack_numbers.length ||
    expectedTail.some((n, i) => n !== progress.recent_uploaded_pack_numbers[i])
  )
    throw new CaptureProgressRejected("capture receipt tail is inconsistent");
  return added;
}
