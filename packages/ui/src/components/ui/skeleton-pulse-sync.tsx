"use client"

import * as React from "react"

const PULSE_CLASS = "animate-pulse"

function isPulseAnimation(animation: Animation) {
  return (
    "animationName" in animation &&
    (animation as CSSAnimation).animationName === "pulse"
  )
}

function timelineNow() {
  const now = document.timeline?.currentTime
  return typeof now === "number" ? now : 0
}

/**
 * Puts every pulse animation in `elements` on one clock: the first pulse
 * found sets the start time and later ones copy it, so all skeleton blocks
 * are in the same phase however late they mounted. Returns the start time
 * in use.
 */
export function alignPulseAnimations(
  elements: Iterable<Element>,
  startTime: number | null,
): number | null {
  let anchor = startTime
  for (const element of elements) {
    if (typeof element.getAnimations !== "function") {
      return anchor
    }
    for (const animation of element.getAnimations()) {
      if (!isPulseAnimation(animation)) {
        continue
      }
      if (anchor === null) {
        anchor =
          typeof animation.startTime === "number"
            ? animation.startTime
            : timelineNow()
      }
      if (animation.startTime !== anchor) {
        animation.startTime = anchor
      }
    }
  }
  return anchor
}

function pulseElementsIn(node: Node): Element[] {
  if (!(node instanceof Element)) {
    return []
  }
  const found = Array.from(node.getElementsByClassName(PULSE_CLASS))
  if (node.classList.contains(PULSE_CLASS)) {
    found.push(node)
  }
  return found
}

/**
 * A pulse starts from full opacity whenever its element mounts. When one
 * skeleton replaces another (the route skeleton, then the page's own), every
 * block would restart together and the screen would blink as if it had
 * reloaded. Mounted once near the root, this keeps every pulse on the clock
 * of the first one (the server-rendered skeleton, when there is one), so a
 * replacement skeleton carries on where the last one was.
 */
export function SkeletonPulseSync() {
  React.useLayoutEffect(() => {
    if (
      typeof MutationObserver === "undefined" ||
      typeof document.getAnimations !== "function"
    ) {
      return
    }
    let anchor = alignPulseAnimations(
      Array.from(document.getElementsByClassName(PULSE_CLASS)),
      null,
    )
    // Mutation callbacks run before the next paint, so new blocks are
    // aligned before they are first drawn.
    const observer = new MutationObserver((records) => {
      const added: Element[] = []
      for (const record of records) {
        if (record.type === "attributes") {
          if (
            record.target instanceof Element &&
            record.target.classList.contains(PULSE_CLASS)
          ) {
            added.push(record.target)
          }
          continue
        }
        record.addedNodes.forEach((node) => {
          added.push(...pulseElementsIn(node))
        })
      }
      if (added.length > 0) {
        anchor = alignPulseAnimations(added, anchor)
      }
    })
    observer.observe(document.body, {
      attributeFilter: ["class"],
      attributes: true,
      childList: true,
      subtree: true,
    })
    return () => observer.disconnect()
  }, [])

  return null
}
