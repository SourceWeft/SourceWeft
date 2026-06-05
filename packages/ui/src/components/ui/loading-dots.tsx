import { cn } from "@/lib/utils"

function LoadingDots({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-label="Loading"
      className={cn(
        "mt-1 flex h-4 items-center gap-1 text-muted-foreground/70",
        className
      )}
      role="status"
      {...props}
    >
      <span className="sr-only">Loading</span>
      <span className="size-1 animate-bounce rounded-full bg-current opacity-75 [animation-duration:850ms] [animation-delay:-0.28s]" />
      <span className="size-1 animate-bounce rounded-full bg-current opacity-75 [animation-duration:850ms] [animation-delay:-0.14s]" />
      <span className="size-1 animate-bounce rounded-full bg-current opacity-75 [animation-duration:850ms]" />
    </div>
  )
}

export { LoadingDots }
