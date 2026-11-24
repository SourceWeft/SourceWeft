import { createHash } from "node:crypto";

/** mulberry32: small, fast, and identical on every platform. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedOf(text: string) {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

/**
 * Reorders options with a shuffle seeded by the item id, so the model's habit
 * of putting the answer first does not survive, while the same item always
 * shows the same order (a regenerated item that keeps its id included).
 */
export function shuffleOptions(
  options: readonly string[],
  correct: readonly number[],
  seed: string,
): { options: string[]; correct: number[] } {
  const random = prng(seedOf(seed));
  const order = options.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  const correctSet = new Set(correct);
  const shuffled = order.map((from) => options[from]!);
  const remapped = order
    .map((from, to) => (correctSet.has(from) ? to : -1))
    .filter((index) => index >= 0);
  return { options: shuffled, correct: remapped };
}
