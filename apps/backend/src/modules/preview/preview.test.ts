import { beforeEach, expect, test, vi } from "vitest";
import { updateUserSettingsRequestSchema } from "@sourceweft/contracts";

vi.mock("@sourceweft/db", () => ({
  database: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("../../shared/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
import { database } from "@sourceweft/db";
import { logger } from "../../shared/logger";
import { PreviewAccessService } from "./access-service";
import { PreviewAdminService } from "./admin-service";
import { PreviewAccessError } from "./errors";
import { parsePreviewFlags } from "./features";
import { normalizeUserSettings } from "../user-settings/settings";
import { UserSettingsService } from "../user-settings/service";
import { UserSettingsRepository } from "../user-settings/repository";

beforeEach(() => vi.clearAllMocks());

test("only explicit booleans grant; missing values deny; malformed values log safely", () => {
  for (const settings of [
    undefined,
    null,
    {},
    { preview: {} },
    { preview: { gmail: false } },
  ]) {
    expect(parsePreviewFlags(settings)).toEqual({ gmail: false });
  }
  expect(logger.warn).not.toHaveBeenCalled();
  for (const settings of [
    [],
    "invalid",
    { preview: null },
    { preview: [] },
    { preview: { gmail: "true" } },
    { preview: { gmail: 1 } },
    { preview: { gmail: true, unexpected: true } },
  ]) {
    expect(parsePreviewFlags(settings, "user-a")).toEqual({ gmail: false });
  }
  expect(logger.warn).toHaveBeenCalledWith("Invalid stored preview settings", {
    userId: "user-a",
    code: "PREVIEW_SETTINGS_INVALID",
  });
  expect(
    parsePreviewFlags({
      appearance: { theme: "bad" },
      preview: { gmail: true },
    }),
  ).toEqual({ gmail: true });
  expect(
    normalizeUserSettings({
      appearance: { theme: "bad" },
      preview: { gmail: true },
    }).preview,
  ).toEqual({ gmail: true });
  expect(
    normalizeUserSettings({
      notes: "x".repeat(20000),
      preview: { gmail: true },
    }).preview,
  ).toEqual({ gmail: true });
  expect(
    normalizeUserSettings({ apiKey: "redacted", preview: { gmail: true } })
      .preview,
  ).toEqual({ gmail: true });
});

test("public patches reject privilege injection and unknown nested fields", async () => {
  for (const patch of [
    { preview: { gmail: true } },
    { appearance: { theme: "dark" }, preview: { gmail: true } },
    { appearance: { theme: "dark", preview: { gmail: true } } },
  ]) {
    expect(updateUserSettingsRequestSchema.safeParse(patch).success).toBe(
      false,
    );
    await expect(
      new UserSettingsService().updateUserSettings({
        userId: "u",
        patch: patch as never,
      }),
    ).rejects.toThrow();
  }
  expect(database.query).not.toHaveBeenCalled();
});

test("access reads persisted state each time, denies safely, and propagates DB errors", async () => {
  vi.mocked(database.query)
    .mockResolvedValueOnce({
      rows: [{ settings: { preview: { gmail: true } } }],
    } as never)
    .mockResolvedValueOnce({
      rows: [{ settings: { preview: { gmail: false } } }],
    } as never);
  const service = new PreviewAccessService();
  await expect(service.isEnabled("u", "gmail")).resolves.toBe(true);
  await expect(service.requireEnabled("u", "gmail")).rejects.toMatchObject({
    statusCode: 403,
    code: "PREVIEW_ACCESS_DENIED",
  });
  const failure = new Error("database unavailable");
  vi.mocked(database.query).mockRejectedValueOnce(failure);
  await expect(service.isEnabled("u", "gmail")).rejects.toBe(failure);
  expect(new PreviewAccessError().message).not.toContain("gmail");
  await expect(service.isEnabled("u", "unknown" as never)).rejects.toThrow();
});

test("admin validates user and arguments, dry-run never writes, success is audited", async () => {
  const repository = new UserSettingsRepository();
  vi.spyOn(repository, "userExists").mockResolvedValue(true);
  vi.spyOn(repository, "findByUserId").mockResolvedValue({
    appearance: { theme: "dark" },
  });
  const write = vi
    .spyOn(repository, "setPreviewFeature")
    .mockResolvedValue({ before: {}, after: { preview: { gmail: true } } });
  const service = new PreviewAdminService(repository);
  const input = {
    userId: "u",
    feature: "gmail" as const,
    actor: "operator",
    reason: "review",
  };
  await expect(
    service.grant({ ...input, dryRun: true }),
  ).resolves.toMatchObject({ before: false, after: true, dryRun: true });
  expect(write).not.toHaveBeenCalled();
  await expect(service.grant(input)).resolves.toMatchObject({
    before: false,
    after: true,
  });
  expect(logger.info).toHaveBeenLastCalledWith(
    "User preview change",
    expect.objectContaining({
      actor: "operator",
      reason: "review",
      outcome: "success",
    }),
  );
  await expect(service.grant({ ...input, actor: "" })).rejects.toThrow();
  await expect(
    service.grant({ ...input, feature: "unknown" as never }),
  ).rejects.toThrow();
  vi.mocked(repository.userExists).mockResolvedValue(false);
  await expect(service.revoke(input)).rejects.toThrow("User not found");
  expect(write).toHaveBeenCalledTimes(1);
});
