import type { ReactNode } from "react";

/** The scrolling column every admin page sits in. */
export function AdminPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">{children}</div>
    </div>
  );
}
