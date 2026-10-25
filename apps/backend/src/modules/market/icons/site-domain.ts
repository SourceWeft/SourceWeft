import { parse } from "tldts";

/**
 * Host and domain rules of the icon dry-run (Issue #367). The registrable
 * domain comes from the Public Suffix List including its private section, so
 * two projects on a shared host (`a.github.io`, `b.github.io`, `x.vercel.app`)
 * are different sites, never one.
 */

/** The lowercase host of an https URL without credentials or a custom port. */
export function httpsHostOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    if (url.port && url.port !== "443") return undefined;
    return url.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/** The registrable domain of `host`; undefined for IP literals and suffixes. */
export function registrableDomainOf(host: string): string | undefined {
  const parsed = parse(host.toLowerCase().replace(/\.$/, ""), {
    allowPrivateDomains: true,
  });
  if (parsed.isIp || !parsed.domain) return undefined;
  return parsed.domain;
}

/** The registrable domain of an http(s) URL's host. */
export function registrableDomainOfUrl(value: string): string | undefined {
  try {
    return registrableDomainOf(new URL(value).hostname);
  } catch {
    return undefined;
  }
}

/** `host` is `domain` or a subdomain of it. */
export function hostIsUnder(host: string, domain: string) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}

/**
 * The same site's two spellings: `example.com` and `www.example.com`. These are
 * the only extra host a redirect or a first-party icon may move to.
 */
export function wwwTwin(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : `www.${host}`;
}
