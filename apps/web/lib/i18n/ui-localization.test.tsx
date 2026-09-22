// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { UiLocalizationProvider } from "@sourceweft/ui-web/components/ui/ui-localization";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@sourceweft/ui-web/components/ui/sheet";

it("updates portal close-button accessible text without closing the dialog or sheet", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (const kind of ["dialog", "sheet"]) {
      for (const close of ["Close", "关闭", "關閉"]) {
        await act(async () =>
          root.render(
            <UiLocalizationProvider messages={{ close }}>
              {kind === "dialog" ? (
                <Dialog open>
                  <DialogContent>
                    <DialogTitle>Title</DialogTitle>
                    <DialogDescription>Description</DialogDescription>
                  </DialogContent>
                </Dialog>
              ) : (
                <Sheet open>
                  <SheetContent>
                    <SheetTitle>Title</SheetTitle>
                    <SheetDescription>Description</SheetDescription>
                  </SheetContent>
                </Sheet>
              )}
            </UiLocalizationProvider>,
          ),
        );
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(
          [...dialog!.querySelectorAll("button")].some(
            (button) => button.textContent === close,
          ),
        ).toBe(true);
      }
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
