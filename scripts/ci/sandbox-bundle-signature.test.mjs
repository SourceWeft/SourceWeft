// Offline signing round trip for the sandbox bundle release asset, using the SAME tools as
// production: `tauri signer sign` produces <tarball>.sig and the update-verifier (Tauri's
// minisign-verify) checks it against the base64 public key. A throwaway key is generated per
// run; no release key or secret is involved. Like desktop-update-signatures.test.mjs it needs
//   cargo build --locked --manifest-path scripts/ci/update-verifier/Cargo.toml
//   DESKTOP_UPDATE_VERIFIER=<path to sourceweft-update-verifier> node --test <this file>
// and a pnpm install (for the Tauri CLI).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { packBundle, verifyTarball } from "./sandbox-bundle.mjs";

const script = fileURLToPath(new URL("./sandbox-bundle.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const tauri = (...args) =>
  spawnSync(
    "pnpm",
    ["--filter", "@sourceweft/desktop", "exec", "tauri", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

async function throwawayKey(dir, password) {
  const keyPath = join(dir, "key");
  const generated = tauri(
    "signer",
    "generate",
    "--ci",
    "-w",
    keyPath,
    "-p",
    password,
  );
  assert.equal(generated.status, 0, generated.stderr);
  return {
    privateKey: await readFile(keyPath, "utf8"),
    publicKey: (await readFile(`${keyPath}.pub`, "utf8")).trim(),
  };
}

async function packedBundle(dir) {
  const bundle = join(dir, "bundle");
  await mkdir(bundle);
  // A complete Linux file set (sandbox-bundle validates the set per target on pack/verify).
  const files = {
    rg: "ripgrep",
    "srt-sidecar": "sidecar",
    "apply-seccomp": "seccomp",
    "srt-proxy-agent.jar": "PK\u0003\u0004jar",
  };
  for (const [name, body] of Object.entries(files))
    await writeFile(join(bundle, name), body);
  await writeFile(
    join(bundle, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      appVersion: "0.3.0-rc.9",
      target: "x86_64-unknown-linux-gnu",
      srtVersion: "0.0.81",
      files: Object.fromEntries(
        Object.entries(files).map(([name, body]) => [
          name,
          {
            sha256: createHash("sha256").update(body).digest("hex"),
            size: body.length,
          },
        ]),
      ),
    }),
  );
  return packBundle(bundle, join(dir, "out"));
}

const cli = (command, tarball, env) =>
  spawnSync(process.execPath, [script, command, tarball], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

test("a throwaway-key signature over the packed tarball verifies with the production verifier and rejects tampering and another key", async (t) => {
  assert(
    process.env.DESKTOP_UPDATE_VERIFIER,
    "Build update-verifier and set DESKTOP_UPDATE_VERIFIER before this integration test",
  );
  const dir = await mkdtemp(join(tmpdir(), "sandbox-bundle-signature-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyDirA = await mkdtemp(join(dir, "key-a-"));
  const keyDirB = await mkdtemp(join(dir, "key-b-"));
  const a = await throwawayKey(keyDirA, "test-password");
  const b = await throwawayKey(keyDirB, "other-password");

  const tarball = await packedBundle(dir);
  await verifyTarball(tarball);

  const signed = cli("sign", tarball, {
    TAURI_SIGNING_PRIVATE_KEY: a.privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-password",
  });
  assert.equal(signed.status, 0, signed.stderr);
  assert.match(await readFile(`${tarball}.sig`, "utf8"), /^[A-Za-z0-9+/=\s]+$/);

  const verify = (key) =>
    cli("verify-signature", tarball, { TAURI_UPDATER_PUBLIC_KEY: key });
  assert.equal(verify(a.publicKey).status, 0, "authentic signature verifies");
  assert.notEqual(verify(b.publicKey).status, 0, "another key is rejected");

  // Any change to the signed bytes breaks the signature.
  const original = await readFile(tarball);
  const flipped = Buffer.from(original);
  flipped[flipped.length - 12] ^= 1;
  await writeFile(tarball, flipped);
  assert.notEqual(
    verify(a.publicKey).status,
    0,
    "tampered tarball is rejected",
  );
  await writeFile(tarball, original);
  assert.equal(verify(a.publicKey).status, 0);

  // CI passes a path relative to the repository root; the signer runs from apps/desktop.
  await rm(`${tarball}.sig`);
  const relativeSign = spawnSync(
    process.execPath,
    [script, "sign", relative(repoRoot, tarball)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: a.privateKey,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-password",
      },
      encoding: "utf8",
    },
  );
  assert.equal(relativeSign.status, 0, relativeSign.stderr);
  assert.equal(
    verify(a.publicKey).status,
    0,
    "relative-path signature verifies",
  );

  const unsigned = cli("sign", tarball, {
    TAURI_SIGNING_PRIVATE_KEY: "",
    TAURI_SIGNING_PRIVATE_KEY_PATH: "",
  });
  assert.notEqual(
    unsigned.status,
    0,
    "signing without a key must fail, not skip",
  );
});
