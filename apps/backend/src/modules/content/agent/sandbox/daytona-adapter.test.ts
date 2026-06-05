import { describe, expect, test } from "vitest";
import {
  assertDaytonaCommandSucceeded,
  isDaytonaImageReference,
  mapDaytonaProviderError,
  normalizeDaytonaDownloadResult,
} from "./daytona-adapter";

describe("isDaytonaImageReference", () => {
  test("detects tagged registry image references", () => {
    expect(
      isDaytonaImageReference(
        "ghcr.io/sourceweft/sourceweft-sandbox-base:node20-tools0.1.0-latest",
      ),
    ).toBe(true);
    expect(isDaytonaImageReference("daytonaio/sandbox:0.8.0")).toBe(true);
    expect(isDaytonaImageReference("daytonaio/sandbox")).toBe(true);
    expect(
      isDaytonaImageReference("ghcr.io/sourceweft/sourceweft-sandbox-base"),
    ).toBe(true);
    expect(isDaytonaImageReference("node:20-bookworm")).toBe(true);
    expect(
      isDaytonaImageReference("localhost:5000/sourceweft/runtime:dev"),
    ).toBe(true);
  });

  test("detects digest image references", () => {
    expect(
      isDaytonaImageReference(
        "ghcr.io/sourceweft/sourceweft-sandbox-base@sha256:e902768f08a0dc24cbfb976160dd40107774227ad8f8ddce65efb6f5c8b77b97",
      ),
    ).toBe(true);
  });

  test("leaves plain Daytona snapshot names as snapshots", () => {
    expect(isDaytonaImageReference("sourceweft-sandbox-base")).toBe(false);
    expect(isDaytonaImageReference("daytona-small")).toBe(false);
    expect(isDaytonaImageReference("sourceweft-runtime-test")).toBe(false);
  });
});

describe("normalizeDaytonaDownloadResult", () => {
  test("keeps Buffer results as stable bytes", () => {
    const input = Buffer.from("hello", "utf8");

    expect(normalizeDaytonaDownloadResult(input)).toEqual(input);
  });

  test("normalizes Uint8Array results", () => {
    const input = new Uint8Array([104, 101, 108, 108, 111]);

    expect(normalizeDaytonaDownloadResult(input)).toEqual(
      Buffer.from("hello", "utf8"),
    );
  });

  test("normalizes ArrayBuffer results", () => {
    const input = new Uint8Array([104, 101, 108, 108, 111]).buffer;

    expect(normalizeDaytonaDownloadResult(input)).toEqual(
      Buffer.from("hello", "utf8"),
    );
  });

  test("normalizes string results as UTF-8", () => {
    expect(normalizeDaytonaDownloadResult("hello")).toEqual(
      Buffer.from("hello", "utf8"),
    );
  });

  test("fails clearly for unsupported result types", () => {
    expect(() => normalizeDaytonaDownloadResult({ content: "hello" })).toThrow(
      "SANDBOX_DOWNLOAD_UNSUPPORTED_RESULT",
    );
  });
});

describe("assertDaytonaCommandSucceeded", () => {
  test("passes successful command results", () => {
    expect(
      assertDaytonaCommandSucceeded(
        { exitCode: 0, artifacts: { stdout: "ok" } },
        { code: "SANDBOX_DIRECTORY_CREATE_FAILED", maxOutputChars: 100 },
      ).output,
    ).toBe("ok");
  });

  test("throws a normalized error for non-zero exit codes", () => {
    expect(() =>
      assertDaytonaCommandSucceeded(
        { exitCode: 1, artifacts: { stderr: "permission denied" } },
        { code: "SANDBOX_DIRECTORY_CREATE_FAILED", maxOutputChars: 100 },
      ),
    ).toThrow("SANDBOX_DIRECTORY_CREATE_FAILED");
  });
});

describe("mapDaytonaProviderError", () => {
  test("maps provider auth failures", () => {
    expect(
      mapDaytonaProviderError({ status: 401 }, "create").message,
    ).toContain("SANDBOX_PROVIDER_AUTH_FAILED");
    expect(
      mapDaytonaProviderError(new Error("invalid api key"), "get").message,
    ).toContain("SANDBOX_PROVIDER_AUTH_FAILED");
  });

  test("maps missing or expired sandboxes", () => {
    expect(
      mapDaytonaProviderError({ statusCode: 404 }, "get").message,
    ).toContain("SANDBOX_NOT_FOUND_OR_EXPIRED");
    expect(
      mapDaytonaProviderError(new Error("sandbox not found"), "execute")
        .message,
    ).toContain("SANDBOX_NOT_FOUND_OR_EXPIRED");
  });

  test("maps missing downloaded files without exposing provider details", () => {
    expect(
      mapDaytonaProviderError(
        new Error("file not found: /tmp/result.txt"),
        "download",
      ).message,
    ).toContain("SANDBOX_FILE_NOT_FOUND");
    expect(
      mapDaytonaProviderError(new Error("ENOENT: no such file"), "download")
        .message,
    ).toContain("SANDBOX_FILE_NOT_FOUND");
  });

  test("maps command timeouts", () => {
    expect(
      mapDaytonaProviderError({ status: 504 }, "execute").message,
    ).toContain("SANDBOX_COMMAND_TIMEOUT");
    expect(
      mapDaytonaProviderError(new Error("process timed out"), "execute")
        .message,
    ).toContain("SANDBOX_COMMAND_TIMEOUT");
  });

  test("maps unknown failures to generic provider errors", () => {
    expect(
      mapDaytonaProviderError(new Error("connection reset"), "upload").message,
    ).toContain("SANDBOX_PROVIDER_ERROR");
  });
});
