import assert from "node:assert/strict";
import test from "node:test";
import { notarizeDiskImage } from "./notarize-macos-dmg.mjs";

const PASSWORD = "abcd-efgh-ijkl-mnop";
const env = {
  DESKTOP_RELEASE_TARGET: "aarch64-apple-darwin",
  APPLE_ID: "release@example.com",
  APPLE_PASSWORD: PASSWORD,
  APPLE_TEAM_ID: "TEAM123456",
};
const directory =
  "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg";
const image = `${directory}/SourceWeft_1.2.3_aarch64.dmg`;

function harness({ verdict, submitStatus = 0, stapler = {} } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    options: {
      env,
      list: () => ["SourceWeft_1.2.3_aarch64.dmg"],
      log: (line) => logs.push(line),
      run: (args) => {
        calls.push(args);
        if (args[1] === "submit")
          return {
            status: submitStatus,
            stdout: verdict === undefined ? "" : JSON.stringify(verdict),
            stderr: "notary service said no",
          };
        if (args[1] === "log")
          return { status: 0, stdout: '{"issues":["unsigned"]}', stderr: "" };
        return {
          status: stapler[args[1]] ?? 0,
          stdout: "",
          stderr: "no ticket",
        };
      },
    },
  };
}

test("an accepted disk image is submitted with the Apple credentials, then stapled and validated", () => {
  const { calls, logs, options } = harness({
    verdict: { id: "abc-123", status: "Accepted" },
  });
  assert.equal(notarizeDiskImage(options), image);
  assert.deepEqual(calls, [
    [
      "notarytool",
      "submit",
      image,
      "--apple-id",
      "release@example.com",
      "--password",
      PASSWORD,
      "--team-id",
      "TEAM123456",
      "--wait",
      "--timeout",
      "30m",
      "--output-format",
      "json",
    ],
    ["stapler", "staple", image],
    ["stapler", "validate", image],
  ]);
  assert.match(logs.join("\n"), /status Accepted for id abc-123/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(PASSWORD));
});

test("a rejected disk image prints the notary log and is never stapled", () => {
  const { calls, logs, options } = harness({
    verdict: { id: "abc-123", status: "Invalid" },
  });
  assert.throws(
    () => notarizeDiskImage(options),
    (error) =>
      /not accepted \(status Invalid\)/.test(error.message) &&
      !error.message.includes(PASSWORD),
  );
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [
      ["notarytool", "submit"],
      ["notarytool", "log"],
    ],
  );
  assert.equal(calls[1][2], "abc-123");
  assert.match(logs.join("\n"), /unsigned/);
});

test("a failed or unreadable submission stops before stapling and never leaks the password", () => {
  for (const options of [
    harness({ submitStatus: 1 }),
    harness({ verdict: undefined }),
  ]) {
    assert.throws(
      () => notarizeDiskImage(options.options),
      (error) =>
        /submission failed|unreadable result/.test(error.message) &&
        !error.message.includes(PASSWORD),
    );
    assert.equal(options.calls.length, 1);
  }
});

test("a stapler failure fails the step", () => {
  for (const action of ["staple", "validate"]) {
    const { options } = harness({
      verdict: { id: "abc-123", status: "Accepted" },
      stapler: { [action]: 65 },
    });
    assert.throws(
      () => notarizeDiskImage(options),
      new RegExp(`stapler ${action} failed`),
    );
  }
});

test("nothing is submitted without every credential, a macOS target and exactly one disk image", () => {
  const refused = (overrides, pattern) => {
    const { calls, options } = harness({
      verdict: { id: "abc-123", status: "Accepted" },
    });
    assert.throws(
      () => notarizeDiskImage({ ...options, ...overrides }),
      pattern,
    );
    assert.equal(calls.length, 0);
  };
  for (const key of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
    refused({ env: { ...env, [key]: "" } }, new RegExp(`${key} is required`));
    refused({ env: { ...env, [key]: "  " } }, new RegExp(`${key} is required`));
  }
  for (const target of [
    undefined,
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ])
    refused(
      { env: { ...env, DESKTOP_RELEASE_TARGET: target } },
      /requires a macOS DESKTOP_RELEASE_TARGET/,
    );
  refused({ list: () => [] }, /Expected one \.dmg/);
  refused({ list: () => ["a.dmg", "b.dmg"] }, /Expected one \.dmg/);
});
