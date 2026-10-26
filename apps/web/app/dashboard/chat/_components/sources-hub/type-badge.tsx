const TONE_CLASSES = {
  default: "border-input bg-secondary text-secondary-foreground",
  // Matches the emerald "public" accent used in the share dialog.
  public:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  // Needs someone's attention, e.g. a version waiting for shared-data approval.
  attention:
    "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
} as const;

export function TypeBadge({
  label,
  tone = "default",
}: {
  label: string;
  tone?: keyof typeof TONE_CLASSES;
}) {
  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}
