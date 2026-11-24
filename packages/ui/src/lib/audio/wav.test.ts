import { expect, test } from "vitest";
import { encodeWav } from "./wav";

// Asserted with vitest's `expect` rather than `node:assert`: this is a browser
// component library, and it declares no `@types/node`.

test("header describes 16 kHz mono 16-bit PCM and the data follows", () => {
  const wav = encodeWav(new Int16Array([1, -2, 3]));
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
  expect(view.getUint16(20, true)).toBe(1); // PCM
  expect(view.getUint16(22, true)).toBe(1); // mono
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(6);
  expect(wav.length).toBe(50);
  expect(view.getInt16(46, true)).toBe(-2);
});
