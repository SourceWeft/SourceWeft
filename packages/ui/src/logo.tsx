import { cn } from "./lib/utils";

export const Logo = ({
  className = "h-8 w-8",
}: {
  className?: string;
}) => (
  <div
    className={cn(
      "flex items-center justify-center rounded-md bg-primary text-primary-foreground",
      className,
    )}
  >
    {/* The asset is drawn in black, so it has to be inverted to read against
        `bg-primary` — which is near-black in light mode and near-white in dark. */}
    <img
      src="/logo-white-bg.svg"
      alt="SourceWeft logo"
      className="h-[90%] w-[90%] object-contain invert dark:invert-0"
    />
  </div>
);
