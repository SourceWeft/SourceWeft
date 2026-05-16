"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { detectNativeHostKind, nativeBridge } from "../lib/native-bridge";
import {
  getMobileSheetTitle,
  isPrimaryMobileRoute,
  resolveMobileRouteAction,
} from "../lib/mobile-route-policy";

type SheetRoute = {
  title: string;
  url: string;
};

async function openExternalUrl(url: URL) {
  try {
    await nativeBridge.openExternalUrl(url.toString());
    return;
  } catch {
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }
}

export function MobileRouteSheetProvider({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [isMobileHost, setIsMobileHost] = useState(false);
  const [sheetRoute, setSheetRoute] = useState<SheetRoute | null>(null);
  const lastPrimaryPathRef = useRef("/auth/sign-in");

  useEffect(() => {
    if (typeof window !== "undefined" && window.parent !== window) {
      return;
    }

    let cancelled = false;

    detectNativeHostKind()
      .then((kind) => {
        if (!cancelled) {
          setIsMobileHost(kind === "mobile");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsMobileHost(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isMobileHost || typeof window === "undefined") {
      return;
    }

    if (pathname === "/") {
      router.replace("/auth/sign-in");
      return;
    }

    if (isPrimaryMobileRoute(pathname)) {
      if (pathname !== "/") {
        lastPrimaryPathRef.current = pathname;
      }
      return;
    }

    const url = new URL(window.location.href);
    setSheetRoute({
      title: getMobileSheetTitle(url.pathname),
      url: url.toString(),
    });

    router.replace(lastPrimaryPathRef.current);
  }, [isMobileHost, pathname, router]);

  useEffect(() => {
    if (!isMobileHost) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || typeof window === "undefined") {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) {
        return;
      }

      const action = resolveMobileRouteAction({
        altKey: event.altKey,
        button: event.button,
        ctrlKey: event.ctrlKey,
        currentUrl: window.location.href,
        download: anchor.hasAttribute("download"),
        href: anchor.getAttribute("href"),
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });

      if (action.type === "allow" || action.type === "ignore") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (action.type === "external") {
        void openExternalUrl(action.url);
        return;
      }

      setSheetRoute({
        title: action.title,
        url: action.url.toString(),
      });
    };

    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
    };
  }, [isMobileHost]);

  return (
    <>
      {children}
      <Sheet
        open={Boolean(sheetRoute)}
        onOpenChange={(open) => {
          if (!open) {
            setSheetRoute(null);
          }
        }}
      >
        <SheetContent
          className="h-[82svh] gap-0 overflow-hidden rounded-t-[28px] border-border/70 p-0 shadow-2xl"
          overlayClassName="bg-black/35"
          side="bottom"
        >
          <SheetHeader className="border-b border-border/70 px-5 py-4 pr-12 text-left">
            <SheetTitle className="text-base">{sheetRoute?.title}</SheetTitle>
            <SheetDescription className="sr-only">
              Supplementary SourceWeft page
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 bg-background">
            {sheetRoute ? (
              <iframe
                className="h-full w-full border-0"
                referrerPolicy="same-origin"
                src={sheetRoute.url}
                title={sheetRoute.title}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
