// Node module-customization-hooks loader, used ONLY by audit.database.test.ts
// to stub `node:dns/promises`'s `resolveTxt` for the `/sso/verify-domain`
// integration test — see that file for why neither `vi.mock` nor mutating
// the CJS-cached module object works here (both `@better-auth/sso`'s
// bundled `dist/index.mjs` and this test file's own code resolve
// `await import("node:dns/promises")` to the pristine, unpatchable ES module
// namespace; only Node's own loader hooks sit below that resolution).
//
// `resolve` redirects the specifier to a synthetic URL; `load` serves a
// small ES module from that URL whose `resolveTxt` reads
// `globalThis.__ssoAuditDnsResolveTxt` at *call* time (so the hook itself,
// which Node runs on a separate loader thread, stays static — only the
// generated module's own code, which runs in the importing thread's realm,
// touches that global). Every other export (`lookup`, used by the plugin's
// OIDC SSRF check) passes straight through to the real module.
const MOCK_URL = "sso-audit-dns-mock:node-dns-promises";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:dns/promises" || specifier === "dns/promises") {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === MOCK_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        import { createRequire } from "node:module";
        const real = createRequire(${JSON.stringify(import.meta.url)})("node:dns/promises");
        export const resolveTxt = (...args) => {
          const override = globalThis.__ssoAuditDnsResolveTxt;
          return override ? override(...args) : real.resolveTxt(...args);
        };
        export const lookup = (...args) => real.lookup(...args);
        export default real;
      `,
    };
  }
  return nextLoad(url, context);
}
