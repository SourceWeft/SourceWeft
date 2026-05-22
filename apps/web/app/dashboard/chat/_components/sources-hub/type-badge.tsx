export function TypeBadge({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-input bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
      {label}
    </span>
  );
}
