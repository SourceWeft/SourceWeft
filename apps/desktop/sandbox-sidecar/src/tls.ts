/**
 * The sidecar's persistent TLS-termination CA.
 *
 * Secret injection needs srt to terminate the sandbox's HTTPS (it swaps a placeholder for the
 * real value inside the request), so the sandboxed command must trust a CA this sidecar holds the
 * key of. srt can mint an ephemeral CA per process, but the host also passes the CA's location to
 * things that outlive one sidecar (and a stable, 0600 key under the app data directory is easier
 * to reason about and to deny to the sandbox than a fresh temp directory), so the CA is persisted
 * under `init.tls.caDir` and only rotated when it is unusable or close to expiry.
 *
 * The files are `ca.crt` (0644: a public certificate) and `ca.key` (0600). The key must stay
 * unreadable to the sandboxed command: the directory sits under the host's sandbox data directory,
 * which the policy already denies, and `buildConfig` denies the key path again by itself.
 *
 * srt's CA helpers are loaded lazily (and by deep import: the package has no `exports` map) so a
 * sidecar that never enables TLS termination does not even load node-forge.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A CA with fewer days than this left is replaced rather than reused. */
export const MIN_CA_REMAINING_DAYS = 30;

const DAY_MS = 86_400_000;

export type CaFiles = {
  certPath: string;
  keyPath: string;
  /** SHA-1 thumbprint of the certificate, uppercase hex. */
  thumbprint: string;
  notAfter: Date;
  /** True when this call created (or replaced) the CA. */
  regenerated: boolean;
};

export type EnsureCaOptions = {
  /** The current time; injectable for tests. */
  now?: () => Date;
};

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Writes `contents` to `path` with `mode` through a temporary file, so a reader never sees half of it. */
function writeAtomically(path: string, contents: string, mode: number): void {
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, contents, { mode, flag: "w" });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Makes sure `<caDir>/ca.crt` and `<caDir>/ca.key` are a usable CA pair with at least
 * `MIN_CA_REMAINING_DAYS` left, creating or replacing them when not, and returns where they are.
 * A pair that is unreadable, not PEM, not RSA, mismatched, not yet valid or nearly expired is
 * replaced; loose permissions on a good pair are tightened instead.
 */
export async function ensureCa(caDir: string, options: EnsureCaOptions = {}): Promise<CaFiles> {
  const { generateCa, validateCaPair } = await import(
    "@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js"
  );
  const now = (options.now ?? (() => new Date()))();
  const certPath = join(caDir, "ca.crt");
  const keyPath = join(caDir, "ca.key");

  mkdirSync(caDir, { recursive: true, mode: 0o700 });
  chmodSync(caDir, 0o700);

  const certPem = readIfPresent(certPath);
  const keyPem = readIfPresent(keyPath);
  if (certPem !== undefined && keyPem !== undefined) {
    const check = validateCaPair(certPem, keyPem);
    if (check.ok && check.notAfter.getTime() - now.getTime() >= MIN_CA_REMAINING_DAYS * DAY_MS) {
      chmodSync(keyPath, 0o600);
      chmodSync(certPath, 0o644);
      return {
        certPath,
        keyPath,
        thumbprint: check.thumbprint,
        notAfter: check.notAfter,
        regenerated: false,
      };
    }
  }

  const generated = generateCa({ cn: "SourceWeft local sandbox CA" });
  // The key goes first: should the process die between the two renames the pair is mismatched,
  // which the next start treats as "regenerate" rather than trusting a half-written CA.
  writeAtomically(keyPath, generated.keyPem, 0o600);
  writeAtomically(certPath, generated.certPem, 0o644);
  const check = validateCaPair(generated.certPem, generated.keyPem);
  if (!check.ok) throw new Error(`generated CA is not usable: ${check.reason}`);
  return {
    certPath,
    keyPath,
    thumbprint: check.thumbprint,
    notAfter: check.notAfter,
    regenerated: true,
  };
}
