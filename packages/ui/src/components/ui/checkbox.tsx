import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export type CheckboxProps = ComponentProps<typeof CheckboxPrimitive.Root>;

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-input bg-background transition-colors",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-primary-foreground">
        {props.checked === "indeterminate" ? (
          <span className="h-px w-2 bg-primary-foreground" />
        ) : (
          <svg
            className="size-2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            viewBox="0 0 12 12"
          >
            <polyline points="1.5,6 4.5,9 10.5,3" />
          </svg>
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
