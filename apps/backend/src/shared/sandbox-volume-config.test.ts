import { afterEach, expect, test, vi } from "vitest";
vi.mock("dotenv/config", () => ({}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function load(enabled?: string, mode?: string) {
  vi.resetModules();
  vi.stubEnv("SOURCEWEFT_SANDBOX_VOLUME_ENABLED", enabled);
  vi.stubEnv("SOURCEWEFT_SANDBOX_VOLUME_MODE", mode);
  return (await import("./config")).config.sandbox.volume;
}
test("absent volume configuration stays disabled and shadow", async () => {
  const settings = await load();
  expect(settings.enabled).toBe(false);
  expect(settings.mode).toBe("shadow");
});
test("volume enablement accepts only explicit strict booleans", async () => {
  for (const [value, result] of [
    ["true", true],
    [" 1 ", true],
    ["FALSE", false],
    ["0", false],
  ] as const) {
    expect((await load(value)).enabled).toBe(result);
  }
});
test("invalid volume enablement cannot silently disable durability", async () => {
  for (const value of ["", "tru", "yes", "on"])
    await expect(load(value)).rejects.toThrow(
      "SOURCEWEFT_SANDBOX_VOLUME_ENABLED",
    );
});
test("explicit modes remain explicit", async () => {
  expect((await load("true", "full")).mode).toBe("full");
  expect((await load("true", "shadow")).mode).toBe("shadow");
});
test("invalid modes cannot silently select shadow instead of restoration", async () => {
  for (const value of ["", "ful", "unsupported"])
    await expect(load("true", value)).rejects.toThrow(
      "SOURCEWEFT_SANDBOX_VOLUME_MODE",
    );
});

test("volume quotas are explicit integers within the current file protocol limit", async () => {
  expect((await load()).limits.maxFileBytes).toBe(8 * 1024 ** 3);
  vi.stubEnv("SOURCEWEFT_SANDBOX_VOLUME_MAX_ENTRIES", "10000");
  expect((await load()).limits.maxEntries).toBe(10000);
  for (const value of ["", "-1", "2.5", "1e4", "9007199254740992"]) {
    vi.stubEnv("SOURCEWEFT_SANDBOX_VOLUME_MAX_ENTRIES", value);
    await expect(load()).rejects.toThrow(
      "SOURCEWEFT_SANDBOX_VOLUME_MAX_ENTRIES",
    );
  }
  vi.stubEnv("SOURCEWEFT_SANDBOX_VOLUME_MAX_ENTRIES", "10000");
  vi.stubEnv(
    "SOURCEWEFT_SANDBOX_VOLUME_MAX_FILE_BYTES",
    String(16 * 1024 ** 3),
  );
  await expect(load()).rejects.toThrow(
    "SOURCEWEFT_SANDBOX_VOLUME_MAX_FILE_BYTES",
  );
});
