import type { ComponentType } from "react";

/** Shared empty state used by every hub tab. */
export function HubEmptyState({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-8 text-center">
      <Icon className="mx-auto size-5 text-muted-foreground" />
      <h4 className="mt-3 text-sm font-medium text-foreground">{title}</h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
