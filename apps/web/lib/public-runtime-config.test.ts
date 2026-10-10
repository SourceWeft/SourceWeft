import { afterEach, expect, test, vi } from "vitest";
import {
  serializePublicConfig,
  serverPublicRuntimeConfig,
  publicRuntimeConfig,
  publicWebBaseUrl,
  resolveUmamiConfig,
} from "./public-runtime-config";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
test("production builds do not inherit publisher NEXT_PUBLIC addresses", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://publisher.example");
  vi.stubEnv("PUBLIC_API_BASE_URL", "");
  vi.stubEnv("PUBLIC_WEB_BASE_URL", "");
  expect(serverPublicRuntimeConfig().apiBaseUrl).toBe("");
});
test("GTM id is read at runtime into analytics.gtmId", () => {
  vi.stubEnv("PUBLIC_GTM_ID", " GTM-ABC ");
  expect(serverPublicRuntimeConfig().analytics.gtmId).toBe("GTM-ABC");
  vi.stubEnv("PUBLIC_GTM_ID", "");
  expect(serverPublicRuntimeConfig().analytics.gtmId).toBeUndefined();
});
test("umami enabled only when both vars are set", () => {
  vi.stubEnv("PUBLIC_UMAMI_SCRIPT_URL", "https://umami.example/script.js");
  vi.stubEnv("PUBLIC_UMAMI_WEBSITE_ID", "site-1");
  expect(serverPublicRuntimeConfig().analytics.umami).toEqual({
    scriptUrl: "https://umami.example/script.js",
    websiteId: "site-1",
  });
});
test("only one umami var logs an error and disables it", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(
    resolveUmamiConfig("https://umami.example/script.js", ""),
  ).toBeUndefined();
  expect(resolveUmamiConfig("", "site-1")).toBeUndefined();
  // Reported once per process: the config is resolved on every request.
  expect(error).toHaveBeenCalledTimes(1);
  error.mockRestore();
});
test("neither umami var disables it silently", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(resolveUmamiConfig("", "")).toBeUndefined();
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});
test("runtime injection controls auth and all request clients without rebuilding", async () => {
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:4567" },
    __SOURCEWEFT_CONFIG__: {
      analytics: {},
      apiBaseUrl: "",
      webBaseUrl: "",
      googleOneTapEnabled: false,
      googleOneTapClientId: "",
      googleOneTapFedCmEnabled: false,
    },
  });
  expect((await import("./api-base-url")).apiBaseUrl).toBe(
    "http://localhost:4567",
  );
  expect(publicWebBaseUrl()).toBe("http://localhost:4567");
  vi.resetModules();
  window.__SOURCEWEFT_CONFIG__!.apiBaseUrl = "https://custom.example";
  expect((await import("./api-base-url")).apiBaseUrl).toBe(
    "https://custom.example",
  );
});
test("serialization cannot terminate the inline configuration script or leak secret keys", () => {
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "must-not-leak");
  vi.stubEnv(
    "PUBLIC_GOOGLE_ONE_TAP_CLIENT_ID",
    "</script><script>bad()</script>",
  );
  const serialized = serializePublicConfig(serverPublicRuntimeConfig());
  expect(serialized).not.toContain("<");
  expect(serialized).not.toContain("must-not-leak");
  expect(JSON.parse(serialized).googleOneTapClientId).toContain("</script>");
});
test("the public configuration reads runtime settings", () => {
  vi.stubEnv("PUBLIC_API_BASE_URL", "http://gateway:8080");
  vi.stubEnv("PUBLIC_WEB_BASE_URL", "https://notes.example");
  expect(publicRuntimeConfig().apiBaseUrl).toBe("http://gateway:8080");
  expect(publicWebBaseUrl()).toBe("https://notes.example");
});
test("desktop recovery is disabled by default and injected only after publication", () => {
  vi.stubEnv("PUBLIC_DESKTOP_RECOVERY_RELEASE", "");
  expect(serverPublicRuntimeConfig().desktopRecoveryRelease).toBeUndefined();
  const release = {
    published: true,
    version: "0.3.1",
    affectedVersions: ["0.3.0-rc.3"],
    downloads: {
      "macos-aarch64":
        "https://download.sourceweft.com/releases/v0.3.1/app.dmg",
    },
  };
  vi.stubEnv("PUBLIC_DESKTOP_RECOVERY_RELEASE", JSON.stringify(release));
  expect(
    JSON.parse(serializePublicConfig(serverPublicRuntimeConfig()))
      .desktopRecoveryRelease.version,
  ).toBe("0.3.1");
  vi.stubEnv(
    "PUBLIC_DESKTOP_RECOVERY_RELEASE",
    JSON.stringify({ ...release, published: false }),
  );
  expect(() => serverPublicRuntimeConfig()).toThrow(
    "PUBLIC_DESKTOP_RECOVERY_RELEASE",
  );
});
