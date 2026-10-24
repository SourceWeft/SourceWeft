/**
 * Local guard against SSRF-style escapes to the sandboxed process's own host or to a
 * private/internal network, independent of whatever srt's own network config denies. This
 * is the full policy from the design's Global Constraints: localhost names, loopback,
 * RFC1918, CGNAT, link-local, multicast, well-known cloud metadata addresses, the IPv6
 * unique-local range, the unspecified address, and — via `own` — every address bound to the
 * sandbox host's own network interfaces.
 *
 * `host` may be a bare hostname, a bare IPv4/IPv6 literal, a bracketed IPv6 literal
 * (`[::1]`), an IPv6 literal with a zone id (`fe80::1%en0`), or any of those written with a
 * trailing dot (the absolute-DNS-name form, e.g. `localhost.`, `127.0.0.1.`) or mixed case.
 * Range membership is decided by `node:net`'s `BlockList`, which does its own numeric IPv6
 * parsing (expanding `::` compression, handling zone ids, and matching embedded-IPv4 forms
 * against IPv6 subnets added in that same embedded notation) — so this module never need
 * parse IPv6 text itself; it only has to construct the right denied ranges, in both their
 * plain and IPv4-embedded forms, once at module load. A hostname that is not
 * `localhost`/`*.localhost` is left alone here — the caller resolves it and re-checks the
 * resolved address (srt's `deniedResolvedAddresses` is the last line of defense for that).
 */
import { BlockList, isIP } from "node:net";

function addV4(blockList: BlockList, address: string, prefix: number): void {
  if (prefix === 32) blockList.addAddress(address, "ipv4");
  else blockList.addSubnet(address, prefix, "ipv4");
}

function addV6(blockList: BlockList, address: string, prefix: number): void {
  if (prefix === 128) blockList.addAddress(address, "ipv6");
  else blockList.addSubnet(address, prefix, "ipv6");
}

/**
 * Adds `v4Address/v4Prefix` to `blockList`, plus its IPv4-mapped (`::ffff:<v4Address>`) and
 * deprecated IPv4-compatible (`::<v4Address>`) IPv6 equivalents at the corresponding
 * `96 + v4Prefix` IPv6 prefix length. `BlockList.check` tells these two forms apart from each
 * other (and from unrelated IPv6 addresses) correctly — confirmed empirically: a `::ffff:...`
 * literal only matches the mapped entry, a plain `::...` (no `ffff`) only matches the
 * compatible entry, and `::`/`::1` match neither (both are excluded by the `96 + v4Prefix`
 * mask, since their last-32-bits-as-IPv4 reading is `0.0.0.0`/`0.0.0.1`, outside every real
 * `v4Address/v4Prefix` this function is called with).
 */
function addV4WithEmbedded(
  blockList: BlockList,
  v4Address: string,
  v4Prefix: number,
): void {
  addV4(blockList, v4Address, v4Prefix);
  const v6Prefix = 96 + v4Prefix;
  addV6(blockList, `::ffff:${v4Address}`, v6Prefix);
  addV6(blockList, `::${v4Address}`, v6Prefix);
}

const UNSPECIFIED = new BlockList();
addV4WithEmbedded(UNSPECIFIED, "0.0.0.0", 32);
addV6(UNSPECIFIED, "::", 128); // redundant with the compatible-form entry above; kept explicit

const LOOPBACK = new BlockList();
addV4WithEmbedded(LOOPBACK, "127.0.0.0", 8);
addV6(LOOPBACK, "::1", 128);

const RFC1918 = new BlockList();
addV4WithEmbedded(RFC1918, "10.0.0.0", 8);
addV4WithEmbedded(RFC1918, "172.16.0.0", 12);
addV4WithEmbedded(RFC1918, "192.168.0.0", 16);

const CGNAT = new BlockList();
addV4WithEmbedded(CGNAT, "100.64.0.0", 10);

const LINK_LOCAL = new BlockList();
addV4WithEmbedded(LINK_LOCAL, "169.254.0.0", 16);
addV6(LINK_LOCAL, "fe80::", 10);

const MULTICAST = new BlockList();
addV4WithEmbedded(MULTICAST, "224.0.0.0", 4);
addV6(MULTICAST, "ff00::", 8);

const CLOUD_METADATA = new BlockList();
addV4WithEmbedded(CLOUD_METADATA, "169.254.169.254", 32); // AWS/GCP/Azure/etc. (also link-local)
addV4WithEmbedded(CLOUD_METADATA, "100.100.100.200", 32); // Alibaba Cloud (also CGNAT)
addV4WithEmbedded(CLOUD_METADATA, "168.63.129.16", 32); // Azure host endpoint
addV4WithEmbedded(CLOUD_METADATA, "192.0.0.192", 32); // Oracle Cloud
addV6(CLOUD_METADATA, "fd00:ec2::", 32); // AWS IPv6 metadata

// fc00::/7 (unique local) has no IPv4-mapped/compatible form of its own — it is already an
// IPv6-only range, so it covers fd00:ec2::/32 above only incidentally (both are checked).
const UNIQUE_LOCAL = new BlockList();
addV6(UNIQUE_LOCAL, "fc00::", 7);

const DENIED_RANGES: ReadonlyArray<readonly [BlockList, string]> = [
  [UNSPECIFIED, "is the unspecified address"],
  [LOOPBACK, "is a loopback address"],
  [RFC1918, "is a private (RFC1918) address"],
  [CGNAT, "is a CGNAT (100.64.0.0/10) address"],
  [LINK_LOCAL, "is a link-local address"],
  [MULTICAST, "is a multicast address"],
  [CLOUD_METADATA, "is a well-known cloud metadata address"],
  [UNIQUE_LOCAL, "is a unique-local (fc00::/7) address"],
];

/** Strips one pair of enclosing `[...]` brackets, if present. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Strips a `%zone` suffix (an IPv6 zone id, e.g. `fe80::1%en0` → `fe80::1`), if present. */
function stripZone(address: string): string {
  const percent = address.indexOf("%");
  return percent === -1 ? address : address.slice(0, percent);
}

/**
 * Builds a `BlockList` from `own` (the host's own interface addresses) that matches not just
 * each literal entry but also, for an IPv4 entry, its IPv4-mapped/compatible IPv6 forms (so a
 * server bound to `0.0.0.0` on a host whose own address is `203.0.113.7` is still caught when
 * reached as `::ffff:203.0.113.7` or its hex-group/compatible equivalents), and, for an IPv6
 * entry, with any zone id stripped (an own address never carries one, but the host string
 * being checked against it might, e.g. `fe80::1234%en0`). Built fresh per call: `own` is
 * expected to hold at most a handful of interface addresses, so this is cheap, and it keeps
 * this guard a pure function of its two arguments rather than caching across calls with
 * mutable interface state.
 */
function buildOwnBlockList(own: ReadonlySet<string>): BlockList {
  const blockList = new BlockList();
  for (const raw of own) {
    const normalized = normalizeHost(raw);
    const family = isIP(normalized);
    if (family === 4) {
      addV4WithEmbedded(blockList, normalized, 32);
    } else if (family === 6) {
      addV6(blockList, stripZone(normalized), 128);
    }
    // An `own` entry that is not a literal IP is not expected (interface addresses always
    // are); silently skip it rather than throw, since this guard must never itself crash the
    // caller over a malformed entry it does not control.
  }
  return blockList;
}

/**
 * Normalizes `host` the same way for every check below: strip one pair of enclosing
 * brackets, lowercase, then strip trailing dot(s) (the absolute-DNS-name form — a resolver
 * treats `localhost.` and `127.0.0.1.` exactly like `localhost` and `127.0.0.1`). Case and
 * the trailing dot are normalized here, once, rather than relying on every downstream check
 * (the localhost-name comparison, `isIP`, `BlockList.check`) to each tolerate them the same
 * way.
 */
function normalizeHost(host: string): string {
  return stripBrackets(host).toLowerCase().replace(/\.+$/, "");
}

/**
 * Returns a human-readable reason `host` must be denied, or `null` if this guard has no
 * objection to it (a plain public name or address — including a name that merely looks like
 * an IP, such as `10.0.0.1.nip.io`, which this guard leaves to the resolved-address check).
 */
export function deniedReason(
  host: string,
  own: ReadonlySet<string>,
): string | null {
  const normalized = normalizeHost(host);

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return `'${host}' is localhost or a *.localhost name`;
  }

  const family = isIP(normalized);
  if (family === 0) {
    // Not an IP literal: a public name (or a name that merely contains an IP-shaped
    // substring, e.g. a nip.io name). The resolved-address check handles this.
    return null;
  }
  const familyName = family === 4 ? "ipv4" : "ipv6";

  if (buildOwnBlockList(own).check(normalized, familyName)) {
    return `'${host}' is an address of the sandbox host's own network interfaces`;
  }

  for (const [blockList, reason] of DENIED_RANGES) {
    if (blockList.check(normalized, familyName)) {
      return `'${host}' ${reason}`;
    }
  }
  return null;
}
