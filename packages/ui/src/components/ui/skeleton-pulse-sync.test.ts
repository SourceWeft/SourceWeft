import { expect, test } from "vitest"

import { alignPulseAnimations } from "./skeleton-pulse-sync"

type FakeAnimation = { animationName?: string; startTime: number | null }

function element(...animations: FakeAnimation[]) {
  return {
    getAnimations: () => animations,
  } as unknown as Element
}

test("later pulses take the start time of the first one", () => {
  const first = { animationName: "pulse", startTime: 1200 }
  const second = { animationName: "pulse", startTime: 3400 }
  const third = { animationName: "pulse", startTime: 5100 }

  const anchor = alignPulseAnimations(
    [element(first), element(second, third)],
    null,
  )

  expect(anchor).toBe(1200)
  expect([first.startTime, second.startTime, third.startTime]).toEqual([
    1200, 1200, 1200,
  ])
})

test("a skeleton that mounts later joins the clock already in use", () => {
  const replacement = { animationName: "pulse", startTime: 9000 }

  expect(alignPulseAnimations([element(replacement)], 1200)).toBe(1200)
  expect(replacement.startTime).toBe(1200)
})

test("other animations on the same element are left alone", () => {
  const spin = { animationName: "spin", startTime: 700 }
  const transition = { startTime: 800 }
  const pulse = { animationName: "pulse", startTime: 900 }

  alignPulseAnimations([element(spin, transition, pulse)], 100)

  expect(spin.startTime).toBe(700)
  expect(transition.startTime).toBe(800)
  expect(pulse.startTime).toBe(100)
})

test("no pulse found leaves the clock unset", () => {
  expect(alignPulseAnimations([element()], null)).toBeNull()
})
