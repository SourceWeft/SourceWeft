import assert from "node:assert/strict";
import { describe, test, vi, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  mail: { provider: "console" },
}));

vi.mock("../../shared/config", () => ({
  config: mockConfig,
}));

import { ConsoleMailProvider } from "./providers/console-provider";
import { PlunkApiProvider } from "./providers/plunk-provider";
import { MailService } from "./service";

afterEach(() => {
  mockConfig.mail.provider = "console";
});

describe("MailService.createProvider (via constructor default)", () => {
  test('"console" returns ConsoleMailProvider', () => {
    mockConfig.mail.provider = "console";
    const svc = new MailService();
    assert.ok(svc["provider"] instanceof ConsoleMailProvider);
  });

  test('"noop" returns ConsoleMailProvider', () => {
    mockConfig.mail.provider = "noop";
    const svc = new MailService();
    assert.ok(svc["provider"] instanceof ConsoleMailProvider);
  });

  test('"plunk" returns PlunkApiProvider', () => {
    mockConfig.mail.provider = "plunk";
    const svc = new MailService();
    assert.ok(svc["provider"] instanceof PlunkApiProvider);
  });

  test("unknown provider throws", () => {
    mockConfig.mail.provider = "sendgrid";
    assert.throws(
      () => new MailService(),
      /^Error: Unsupported mail provider: sendgrid$/,
    );
  });
});
