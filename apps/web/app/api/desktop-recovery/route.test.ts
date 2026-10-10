import { afterEach, expect, test, vi } from "vitest";
import { GET } from "./route";
const url = "https://download.sourceweft.com/releases/v0.3.1/app.dmg";
afterEach(() => vi.unstubAllEnvs());
test("only a configured published version and platform redirect; withdrawal is uncached", () => {
  const request = new Request(
    "https://sourceweft.com/api/desktop-recovery?target=macos-aarch64&version=0.3.1",
  );
  vi.stubEnv("PUBLIC_DESKTOP_RECOVERY_RELEASE", "");
  expect(GET(request).status).toBe(404);
  vi.stubEnv(
    "PUBLIC_DESKTOP_RECOVERY_RELEASE",
    JSON.stringify({
      published: true,
      version: "0.3.1",
      affectedVersions: ["0.3.0-rc.3"],
      downloads: { "macos-aarch64": url },
    }),
  );
  const response = GET(request);
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(url);
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const query of [
    "target=windows-x86_64&version=0.3.1",
    "target=macos-aarch64&version=0.3.0",
    "target=toString&version=0.3.1",
    "url=https://evil.example",
  ])
    expect(
      GET(new Request(`https://sourceweft.com/api/desktop-recovery?${query}`))
        .status,
    ).toBe(404);
  vi.stubEnv("PUBLIC_DESKTOP_RECOVERY_RELEASE", "");
  expect(GET(request).status).toBe(404);
});
