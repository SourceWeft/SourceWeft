import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isRecord,
  readNumber,
  readReferenceId,
  readString,
  toObjectRecord,
} from "../src/server/records";

// toObjectRecord / isRecord: the plain-object shape guard shared across the
// backend. Covered lightly here; the payload readers below are the new
// surface this file adds.

test("toObjectRecord narrows a plain object and rejects everything else", () => {
  assert.deepEqual(toObjectRecord({ a: 1 }), { a: 1 });
  assert.equal(toObjectRecord(null), null);
  assert.equal(toObjectRecord(undefined), null);
  assert.equal(toObjectRecord("x"), null);
  assert.equal(toObjectRecord(42), null);
  assert.equal(toObjectRecord([1, 2]), null);
});

test("isRecord mirrors toObjectRecord as a predicate", () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([1, 2]), false);
});

// readString: a trimmed-non-empty string at record[key], else null. The
// value itself is returned as-is (not trimmed) once it passes the check —
// matching the Creem provider copies this replaces.

test("readString returns a non-empty string as-is", () => {
  assert.equal(readString({ key: "value" }, "key"), "value");
});

test("readString returns the original value untrimmed once it passes the trim check", () => {
  assert.equal(readString({ key: "  padded  " }, "key"), "  padded  ");
});

test("readString rejects a whitespace-only string", () => {
  assert.equal(readString({ key: "   " }, "key"), null);
});

test("readString rejects an empty string, a missing key, and a null record", () => {
  assert.equal(readString({ key: "" }, "key"), null);
  assert.equal(readString({}, "key"), null);
  assert.equal(readString(null, "key"), null);
});

test("readString rejects a non-string value", () => {
  assert.equal(readString({ key: 42 }, "key"), null);
  assert.equal(readString({ key: null }, "key"), null);
  assert.equal(readString({ key: undefined }, "key"), null);
  assert.equal(readString({ key: { nested: true } }, "key"), null);
});

// readNumber: a finite number at record[key], else null. NaN and Infinity
// must never pass through: a non-finite value must never reach the
// reversal core (see amountUnavailableCause's `refundAmount <= 0` guard in
// creem-reversal-sync.ts, which NaN and Infinity both evade).

test("readNumber returns a number as-is, including zero and negatives", () => {
  assert.equal(readNumber({ key: 42 }, "key"), 42);
  assert.equal(readNumber({ key: 0 }, "key"), 0);
  assert.equal(readNumber({ key: -5 }, "key"), -5);
});

test("readNumber rejects NaN, Infinity, and -Infinity", () => {
  assert.equal(readNumber({ key: NaN }, "key"), null);
  assert.equal(readNumber({ key: Infinity }, "key"), null);
  assert.equal(readNumber({ key: -Infinity }, "key"), null);
});

test("readNumber rejects a numeric string, a missing key, and a null record", () => {
  assert.equal(readNumber({ key: "42" }, "key"), null);
  assert.equal(readNumber({}, "key"), null);
  assert.equal(readNumber(null, "key"), null);
});

test("readNumber rejects null and undefined values", () => {
  assert.equal(readNumber({ key: null }, "key"), null);
  assert.equal(readNumber({ key: undefined }, "key"), null);
});

// readReferenceId: a bare string id, or an embedded object's own `id`,
// else null. Creem's `subscription`/`order`/`product` references show up
// in both shapes depending on the event.

test("readReferenceId returns a trimmed-non-empty string as-is", () => {
  assert.equal(readReferenceId("ref_1"), "ref_1");
});

test("readReferenceId rejects a whitespace-only string", () => {
  assert.equal(readReferenceId("   "), null);
});

test("readReferenceId reads an embedded object's id", () => {
  assert.equal(readReferenceId({ id: "obj_1" }), "obj_1");
});

test("readReferenceId rejects an object without a usable id", () => {
  assert.equal(readReferenceId({ id: "   " }), null);
  assert.equal(readReferenceId({ id: 42 }), null);
  assert.equal(readReferenceId({}), null);
});

test("readReferenceId rejects null, undefined, and other non-string primitives", () => {
  assert.equal(readReferenceId(null), null);
  assert.equal(readReferenceId(undefined), null);
  assert.equal(readReferenceId(42), null);
  assert.equal(readReferenceId(true), null);
});
