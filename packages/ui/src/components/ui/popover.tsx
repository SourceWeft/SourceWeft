"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

const PopoverPointerContext = React.createContext<React.MutableRefObject<boolean> | null>(null)

function composeEventHandlers<E extends { defaultPrevented: boolean }>(
  theirHandler: ((event: E) => void) | undefined,
  ourHandler: (event: E) => void,
) {
  return (event: E) => {
    theirHandler?.(event)

    if (!event.defaultPrevented) {
      ourHandler(event)
    }
  }
}

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const openedWithPointerRef = React.useRef(false)

  return (
    <PopoverPointerContext.Provider value={openedWithPointerRef}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </PopoverPointerContext.Provider>
  )
}

function PopoverTrigger({
  onKeyDown,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const openedWithPointerRef = React.useContext(PopoverPointerContext)

  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      onKeyDown={composeEventHandlers(onKeyDown, () => {
        if (openedWithPointerRef) {
          openedWithPointerRef.current = false
        }
      })}
      onPointerDown={composeEventHandlers(onPointerDown, () => {
        if (openedWithPointerRef) {
          openedWithPointerRef.current = true
        }
      })}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  onCloseAutoFocus,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const openedWithPointerRef = React.useContext(PopoverPointerContext)

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        onCloseAutoFocus={composeEventHandlers(onCloseAutoFocus, (event) => {
          if (!openedWithPointerRef?.current) {
            return
          }

          openedWithPointerRef.current = false
          event.preventDefault()
        })}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
