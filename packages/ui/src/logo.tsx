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
    <img
      src="/logo-white-bg.svg"
      alt="SourceWeft logo"
      className="h-[90%] w-[90%] object-contain dark:invert"
    />
  </div>
);
