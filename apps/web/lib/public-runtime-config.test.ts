import { afterEach, expect, test, vi } from "vitest";
import {
  serializePublicConfig,
  serverPublicRuntimeConfig,
  publicRuntimeConfig,
  publicWebBaseUrl,
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
test("runtime injection controls auth and all request clients without rebuilding", async () => {
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:4567" },
    __SOURCEWEFT_CONFIG__: {
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
