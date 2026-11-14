import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { SW_LOCALE_COOKIE } from "../../../lib/i18n/constants";
import { config, proxy } from "../../../proxy";
import { GET } from "./route";

const PATH = "/.well-known/apple-app-site-association";

describe("apple-app-site-association", () => {
  it("is served as JSON with a 200", () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("location")).toBeNull();
  });

  it("associates the iOS app with dashboard pages only", async () => {
    expect(await GET().json()).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["PBML833M58.nicelab.sourceweft.mobile"],
            components: [{ "/": "/dashboard" }, { "/": "/dashboard/*" }],
          },
        ],
      },
    });
  });

  it("is never redirected or rewritten by the proxy, whatever the visitor's language", () => {
    // The matcher's file-extension exclusion does not cover this path, so the
    // proxy really runs on it.
    expect(unstable_doesMiddlewareMatch({ config, url: PATH })).toBe(true);
    for (const cookie of [undefined, `${SW_LOCALE_COOKIE}=zh-CN`]) {
      const headers = new Headers({ "accept-language": "zh-CN,zh;q=0.9" });
      if (cookie) headers.set("cookie", cookie);
      const response = proxy(
        new NextRequest(`https://sourceweft.com${PATH}`, { headers }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    }
  });
});
