export const ASSISTANT_ACTIVITY_ROW_CLASS =
  "flex min-h-8 w-full items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-muted/30";

// The icon sits flush left in its box so its edge lines up with the answer
// text, which is inset by the same px-1 as the row.
export const ASSISTANT_ACTIVITY_ICON_CLASS =
  "flex size-5 shrink-0 items-center justify-start text-muted-foreground/80";

export const ASSISTANT_ACTIVITY_LABEL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1.5";

// An expanded row's detail hangs off a guide line under the row's icon (the
// 14px glyph starts at the row's 4px inset, so its centre is at 11px), and its
// text starts where the row label does: 4px inset + 20px icon box + 4px gap =
// 28px = 10px margin + 1px line + 17px padding.
const ASSISTANT_ACTIVITY_DETAIL_RAIL =
  "ml-[10px] border-l border-border/70 py-1 pl-[17px] pr-1 text-[13px] text-muted-foreground/75 leading-5";

export const ASSISTANT_ACTIVITY_DETAIL_CLASS = `${ASSISTANT_ACTIVITY_DETAIL_RAIL} space-y-1.5`;

export const ASSISTANT_ACTIVITY_DETAIL_TEXT_CLASS = `${ASSISTANT_ACTIVITY_DETAIL_RAIL} whitespace-pre-wrap break-words`;
