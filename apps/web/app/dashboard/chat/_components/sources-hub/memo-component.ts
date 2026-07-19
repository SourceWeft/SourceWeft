import { memo } from "react";

export function memoComponent<T extends (...args: never[]) => unknown>(
  component: T,
) {
  return memo(component as never) as unknown as T;
}
