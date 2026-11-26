// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { flush, mount, unmountAll } from "@/test/react";
import { findHostNativeBridge } from "./native-bridge";
import {
  isIosApp,
  purchasesAllowedIn,
  resetNativeHostForTests,
  thirdPartyTagsAllowedIn,
  useNativeHost,
  usePurchasesAllowed,
} from "./native-host";

type Bridge = NonNullable<Window["__SOURCEWEFT_NATIVE__"]>;

function bridge(overrides: Partial<Bridge>): Bridge {
  return {
    kind: "mobile",
    capabilities: [],
    invoke: (async () => ({})) as Bridge["invoke"],
    listen: async () => async () => {},
    ...overrides,
  };
}

function Probe() {
  const host = useNativeHost();
  const allowed = usePurchasesAllowed();
  return createElement(
    "output",
    null,
    `${host.kind}:${"platform" in host ? host.platform : "-"}:${allowed}`,
  );
}

const shown = () => document.querySelector("output")?.textContent;

afterEach(async () => {
  await unmountAll();
  delete window.__SOURCEWEFT_NATIVE__;
  resetNativeHostForTests();
});

describe("purchasesAllowedIn", () => {
  it("allows purchases on the web, on the desktop app, on Android and before the host is known", () => {
    for (const host of [
      { kind: "unknown" },
      { kind: "web" },
      { kind: "desktop" },
      { kind: "mobile", platform: "android" },
    ] as const) {
      expect(purchasesAllowedIn(host)).toBe(true);
      expect(isIosApp(host)).toBe(false);
    }
  });

  it("allows none in the iOS app, or in a mobile app that has not named its platform", () => {
    expect(purchasesAllowedIn({ kind: "mobile", platform: "ios" })).toBe(false);
    expect(isIosApp({ kind: "mobile", platform: "ios" })).toBe(true);
    expect(purchasesAllowedIn({ kind: "mobile", platform: null })).toBe(false);
    expect(isIosApp({ kind: "mobile", platform: null })).toBe(false);
  });
});

describe("thirdPartyTagsAllowedIn", () => {
  it("allows the tag manager on the web, on the desktop app and on Android", () => {
    for (const host of [
      { kind: "web" },
      { kind: "desktop" },
      { kind: "mobile", platform: "android" },
    ] as const) {
      expect(thirdPartyTagsAllowedIn(host)).toBe(true);
    }
  });

  it("keeps it out of the iOS app, an unnamed mobile app and a host not known yet", () => {
    for (const host of [
      { kind: "mobile", platform: "ios" },
      { kind: "mobile", platform: null },
      { kind: "unknown" },
    ] as const) {
      expect(thirdPartyTagsAllowedIn(host)).toBe(false);
    }
  });
});

describe("useNativeHost", () => {
  it("is unknown, with purchases allowed, in the server render", () => {
    window.__SOURCEWEFT_NATIVE__ = bridge({ platform: "ios" });
    expect(renderToStaticMarkup(createElement(Probe))).toContain(
      "unknown:-:true",
    );
  });

  it("is the web in a browser tab", async () => {
    await mount(createElement(Probe));
    expect(shown()).toBe("web:-:true");
  });

  it("reads the platform from the bridge at once", async () => {
    window.__SOURCEWEFT_NATIVE__ = bridge({ platform: "iOS" });
    await mount(createElement(Probe));
    expect(shown()).toBe("mobile:ios:false");
  });

  it("asks an older app for its platform, and sells nothing until it answers", async () => {
    let answer: (info: { platform: string }) => void = () => {};
    window.__SOURCEWEFT_NATIVE__ = bridge({
      invoke: ((command: string) => {
        expect(command).toBe("mobile_info");
        return new Promise((resolve) => {
          answer = resolve as typeof answer;
        });
      }) as Bridge["invoke"],
    });

    await mount(createElement(Probe));
    expect(shown()).toBe("mobile:null:false");

    answer({ platform: "android" });
    await flush();
    expect(shown()).toBe("mobile:android:true");
  });

  it("keeps selling nothing when an older app cannot say what it runs on", async () => {
    window.__SOURCEWEFT_NATIVE__ = bridge({
      invoke: (async () => {
        throw new Error("not allowed");
      }) as Bridge["invoke"],
    });
    await mount(createElement(Probe));
    await flush();
    expect(shown()).toBe("mobile:null:false");
  });

  it("treats the desktop app as a place where purchases are allowed", async () => {
    window.__SOURCEWEFT_NATIVE__ = bridge({ kind: "desktop" });
    await mount(createElement(Probe));
    expect(shown()).toBe("desktop:-:true");
  });
});

describe("findHostNativeBridge", () => {
  it("finds the app's bridge from a same-origin frame inside it", () => {
    const appBridge = bridge({ platform: "ios" });
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const inner = frame.contentWindow as Window;
    // The test environment's global `window` is a copy of the page's window,
    // so the bridge goes on the frame's real parent, where the app puts it.
    const top = inner.parent;
    top.__SOURCEWEFT_NATIVE__ = appBridge;
    try {
      expect(inner).not.toBe(top);
      expect(inner.__SOURCEWEFT_NATIVE__).toBeUndefined();
      expect(findHostNativeBridge(inner)).toBe(appBridge);
      expect(findHostNativeBridge(top)).toBe(appBridge);
    } finally {
      delete top.__SOURCEWEFT_NATIVE__;
      frame.remove();
    }
  });

  it("finds nothing in a plain browser tab", () => {
    expect(findHostNativeBridge()).toBeUndefined();
  });
});
