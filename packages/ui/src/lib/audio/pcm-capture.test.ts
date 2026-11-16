import { expect, test } from "vitest";
import { createFrameAssembler } from "./pcm-capture";

// Asserted with vitest's `expect` rather than `node:assert`: this is a browser
// component library, and it declares no `@types/node`. These tests cover
// `createFrameAssembler` only: `startPcmCapture` touches `navigator` and
// `AudioContext`, which do not exist in this (node) test environment.

test("48 kHz input becomes 320-sample frames at a third of the length", () => {
  const assembler = createFrameAssembler(48000);
  const frames = [
    assembler.push(new Float32Array(4800).fill(0.5)),
    assembler.push(new Float32Array(4800).fill(0.5)),
  ].flat();
  expect(frames).toHaveLength(10); // 9600 / 3 / 320
  expect(frames.every((f) => f.length === 320)).toBe(true);
  expect(frames[3]![10]).toBeCloseTo(0.5 * 32767, -1);
});

test("a partial frame is kept for the next block", () => {
  const assembler = createFrameAssembler(16000);
  expect(assembler.push(new Float32Array(300))).toHaveLength(0);
  expect(assembler.push(new Float32Array(20))).toHaveLength(1);
});

test("samples beyond ±1 are clamped", () => {
  const [frame] = createFrameAssembler(16000).push(new Float32Array(320).fill(2));
  expect(frame![0]).toBe(32767);
});
