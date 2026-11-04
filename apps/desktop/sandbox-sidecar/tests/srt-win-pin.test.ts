import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SRT_WIN_PIN_FILENAME,
  assertSrtWinMatchesPin,
  parseSrtWinPin,
  readSrtWinPin,
} from "../scripts/manifest.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const X64 = "x86_64-pc-windows-msvc";
const ARM64 = "aarch64-pc-windows-msvc";
const HASH = "a".repeat(64);

test("the committed pin names both Windows targets with lowercase sha256 hashes", () => {
  const pin = readSrtWinPin();
  assert.match(pin.tag, /^v\d+\.\d+\.\d+-sourceweft\.\d+$/);
  assert.deepEqual(Object.keys(pin.srtWin).sort(), [ARM64, X64]);
  for (const hash of Object.values(pin.srtWin)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(pin.srtWin[X64], pin.srtWin[ARM64]);
});

// The pin is derived from one published fork tag, and the dependency that supplies the bundled
// srt-win.exe must be that very tag.
test("the pin's tag is the fork tag in package.json", () => {
  const pin = readSrtWinPin();
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const url = manifest.dependencies["@anthropic-ai/sandbox-runtime"];
  assert.equal(
    url,
    `https://github.com/SourceWeft/sandbox-runtime/releases/download/${pin.tag}/sandbox-runtime-${pin.tag}.tgz`,
  );
});

// Where the dependency is installed, the srt-win.exe it ships must be the pinned one for both
// architectures (the bundle build copies exactly these files).
test("the installed fork package ships the pinned srt-win.exe for both architectures", (t) => {
  const vendor = join(packageRoot, "node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win");
  if (!existsSync(join(vendor, "x64", "srt-win.exe"))) {
    t.skip("the sandbox-runtime package is not installed");
    return;
  }
  const pin = readSrtWinPin();
  for (const [target, arch] of [
    [X64, "x64"],
    [ARM64, "arm64"],
  ] as const) {
    const sha = createHash("sha256").update(readFileSync(join(vendor, arch, "srt-win.exe"))).digest("hex");
    assert.equal(sha, pin.srtWin[target], `${arch} srt-win.exe`);
  }
});

test("the pin file is where the desktop app embeds it from", () => {
  assert.ok(existsSync(join(packageRoot, SRT_WIN_PIN_FILENAME)));
  assert.equal(SRT_WIN_PIN_FILENAME, "srt-win-pin.json");
});

test("assertSrtWinMatchesPin accepts the pinned hash, case-insensitively", () => {
  const pin = parseSrtWinPin(JSON.stringify({ tag: "v1.0.0-sourceweft.1", srtWin: { [X64]: HASH } }));
  assertSrtWinMatchesPin(X64, HASH, pin);
  assertSrtWinMatchesPin(X64, HASH.toUpperCase(), pin);
});

test("assertSrtWinMatchesPin rejects a different file, naming target, tag and both hashes", () => {
  const pin = parseSrtWinPin(JSON.stringify({ tag: "v1.0.0-sourceweft.1", srtWin: { [X64]: HASH } }));
  assert.throws(
    () => assertSrtWinMatchesPin(X64, "b".repeat(64), pin),
    (error: Error) =>
      error.message.includes(X64) &&
      error.message.includes("v1.0.0-sourceweft.1") &&
      error.message.includes("b".repeat(64)) &&
      error.message.includes(HASH) &&
      /signed/i.test(error.message),
  );
  // A target with no pin is not guessed at.
  assert.throws(() => assertSrtWinMatchesPin(ARM64, HASH, pin), /no srt-win\.exe pin for aarch64-pc-windows-msvc/);
});

test("parseSrtWinPin refuses anything that is not a tag with sha256 hashes", () => {
  for (const bad of [
    "",
    "{}",
    "[]",
    JSON.stringify({ tag: "", srtWin: { [X64]: HASH } }),
    JSON.stringify({ tag: "t", srtWin: {} }),
    JSON.stringify({ tag: "t", srtWin: { [X64]: HASH.toUpperCase() } }),
    JSON.stringify({ tag: "t", srtWin: { [X64]: HASH.slice(1) } }),
    JSON.stringify({ tag: "t", srtWin: { [X64]: 7 } }),
    JSON.stringify({ srtWin: { [X64]: HASH } }),
  ]) {
    assert.throws(() => parseSrtWinPin(bad), Error, bad);
  }
});
