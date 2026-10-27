/**
 * Local guard against SSRF-style escapes to the sandboxed process's own host or to a
 * private/internal network, independent of whatever srt's own network config denies. This
 * is the full policy from the design's Global Constraints: localhost names, loopback,
 * RFC1918, CGNAT, link-local, multicast, well-known cloud metadata addresses, the IPv6
 * unique-local range, the unspecified address, the documentation, reserved and
 * non-global-unicast ranges (`UNROUTABLE_V4`/`UNROUTABLE_V6`, including the local-use NAT64
 * prefix), the IPv4-embedding IPv6 forms of all of the above, and — via `own` — every address
 * bound to the sandbox host's own network interfaces.
 *
 * `host` may be a bare hostname, a bare IPv4/IPv6 literal in any spelling srt's proxy accepts
 * (dotted quad, inet_aton shorthand, integer, hex or octal), a bracketed IPv6 literal
 * (`[::1]`), or any of those written with a trailing dot (the absolute-DNS-name form, e.g.
 * `localhost.`, `127.0.0.1.`) or mixed case. An IPv6 literal with a zone id (`fe80::1%en0`) is
 * denied: srt cannot canonicalise it either.
 * Range membership is decided by `node:net`'s `BlockList`, which does its own numeric IPv6
 * parsing (expanding `::` compression, handling zone ids, and matching embedded-IPv4 forms
 * against IPv6 subnets added in that same embedded notation) — so this module never need
 * parse IPv6 text itself; it only has to construct the right denied ranges, in both their
 * plain and IPv4-embedded forms, once at module load. A hostname that is not
 * `localhost`/`*.localhost` is left alone here — the caller resolves it and re-checks the
 * resolved address (srt's `deniedResolvedAddresses` is the last line of defense for that).
 *
 * Final review C1: srt hands the ask callback the host exactly as the client spelled it, but
 * dials the spelling its own `canonicalizeHost` produces (WHATWG URL host parsing: `127.1`,
 * `2130706433`, `0x7f.0.0.1`, `0177.0.0.1` all become `127.0.0.1`), and srt never re-judges an
 * IP literal after that. So every check here runs on `canonicalHost(host)` — the same
 * canonicalisation — never on the raw spelling, and a host that cannot be canonicalised at all
 * is denied rather than passed through.
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
 * compatible entry. `::`/`::1` read as `0.0.0.0`/`0.0.0.1` in their last 32 bits, so only the
 * `0.0.0.0/8` entry's compatible form matches them (both are denied in their own right too).
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
  // The other forms srt's own resolved-address guard decodes (`embeddedIPv4` in srt's
  // `address.js`): IPv4-translated (`::ffff:0:a.b.c.d`), the NAT64 well-known prefix
  // (`64:ff9b::/96`) and 6to4 (`2002:AABB:CCDD::/48`, the IPv4 address in bits 16-47).
  addV6(blockList, `::ffff:0:${v4Address}`, v6Prefix);
  addV6(blockList, `64:ff9b::${v4Address}`, v6Prefix);
  addV6(blockList, sixToFour(v4Address), 16 + v4Prefix);
}

/** The 6to4 (`2002::/16`) network address that embeds dotted-quad `v4Address`. */
function sixToFour(v4Address: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = v4Address.split(".").map(Number);
  const group = (high: number, low: number): string => ((high << 8) | low).toString(16);
  return `2002:${group(a, b)}:${group(c, d)}::`;
}

// 0.0.0.0/8 ("this network"; Linux dials 0.0.0.0 as the local host), whose IPv4-compatible
// form `::0.0.0.0/104` also covers `::` and `::1` (both are denied anyway, below).
const UNSPECIFIED = new BlockList();
addV4WithEmbedded(UNSPECIFIED, "0.0.0.0", 8);
addV6(UNSPECIFIED, "::", 128); // redundant with the compatible-form entry above; kept explicit

const BROADCAST = new BlockList();
addV4WithEmbedded(BROADCAST, "255.255.255.255", 32);

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

/**
 * Documentation, reserved and non-global-unicast ranges, shared by both address layers: this
 * module judges IP *literals* with it, and `policy.ts` passes the same list to srt as
 * `deniedResolvedAddresses`, so a hostname that resolves into one is refused too. (srt's own
 * resolved-address check never re-judges an IP literal, so each layer needs the full list.)
 * It carries over the parts of the retired macOS proxy's `public_address` that srt's built-in
 * set does not cover; `tests/address-guard-parity.test.ts` checks the two against each other.
 *
 * - `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`: documentation
 *   (RFC 5737 / RFC 3849).
 * - `240.0.0.0/4`: reserved for future use (includes the broadcast address).
 * - IPv6 outside `2000::/3` (global unicast): the six blocks `100::/8` … `8000::/1`. The list
 *   deliberately starts at `100::/8`, not `::/3`: `::/8` holds the IPv4-embedding forms
 *   (IPv4-mapped `::ffff:0:0/96`, IPv4-compatible, IPv4-translated, NAT64 `64:ff9b::/96`) that
 *   srt, and this module's `DENIED_RANGES`, judge by the IPv4 address they carry — on an
 *   IPv6-only/NAT64 network a public name resolves into `64:ff9b::/96`, so denying `::/8`
 *   wholesale would cut off real public hosts. None of those blocks is currently allocated as
 *   public global unicast, so a public host does not answer from them today.
 * - `64:ff9b:1::/48`: the local-use NAT64 prefix (RFC 8215). Unlike the well-known `64:ff9b::/96`
 *   it is not a public translation: its embedded IPv4 address is operator-defined and may be a
 *   private one, which this module cannot decode, so the whole prefix is refused.
 *
 * Deliberately NOT listed: `198.18.0.0/15` (RFC 2544 benchmarking). The retired proxy denied it,
 * but it is no private network, and Clash/TUN-style "fake-IP" DNS answers public names with
 * 198.18.x.x addresses; denying it would break all egress for those users (ruling of the macOS
 * migration plan). Also not listed: `192.0.0.0/24` (IETF protocol assignments; the retired
 * proxy allowed it, and Oracle's metadata address inside it is listed individually).
 */
export const UNROUTABLE_V4: readonly string[] = [
  "192.0.2.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "240.0.0.0/4",
];
export const UNROUTABLE_V6: readonly string[] = [
  "2001:db8::/32",
  "64:ff9b:1::/48",
  "100::/8",
  "200::/7",
  "400::/6",
  "800::/5",
  "1000::/4",
  "4000::/2",
  "8000::/1",
];

const UNROUTABLE = new BlockList();
for (const cidr of UNROUTABLE_V4) {
  const [address = "", prefix = ""] = cidr.split("/");
  addV4WithEmbedded(UNROUTABLE, address, Number(prefix));
}
for (const cidr of UNROUTABLE_V6) {
  const [address = "", prefix = ""] = cidr.split("/");
  addV6(UNROUTABLE, address, Number(prefix));
}

// fc00::/7 (unique local) has no IPv4-mapped/compatible form of its own — it is already an
// IPv6-only range, so it covers fd00:ec2::/32 above only incidentally (both are checked).
const UNIQUE_LOCAL = new BlockList();
addV6(UNIQUE_LOCAL, "fc00::", 7);

const DENIED_RANGES: ReadonlyArray<readonly [BlockList, string]> = [
  [UNSPECIFIED, "is an unspecified (0.0.0.0/8 or ::) address"],
  [BROADCAST, "is the broadcast address"],
  [LOOPBACK, "is a loopback address"],
  [RFC1918, "is a private (RFC1918) address"],
  [CGNAT, "is a CGNAT (100.64.0.0/10) address"],
  [LINK_LOCAL, "is a link-local address"],
  [MULTICAST, "is a multicast address"],
  [CLOUD_METADATA, "is a well-known cloud metadata address"],
  [UNIQUE_LOCAL, "is a unique-local (fc00::/7) address"],
  [UNROUTABLE, "is a documentation, reserved or non-global-unicast address"],
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
 * `host` as srt will dial it, or `null` when srt's own canonicalisation would fail. This is the
 * algorithm of srt's `canonicalizeHost` (`parent-proxy.js`), which the HTTP CONNECT handler,
 * the plain-HTTP handler and the SOCKS handler all apply before dialing: strip one pair of
 * brackets, parse the host with the WHATWG URL parser (IPv6 bracketed so it parses as one),
 * strip the brackets again, and strip a trailing dot. The URL parser lowercases names,
 * converts IDNs to punycode, and turns every inet_aton spelling of an IPv4 address (`127.1`,
 * `2130706433`, `0x7f.0.0.1`, `0177.0.0.1`, `10.1`, `169.254.43518`) into its dotted-quad
 * form. It rejects a zone id (`fe80::1%en0`) and a name whose last label is numeric but not a
 * valid IPv4 address (`foo.123`); srt then falls back to the raw spelling, which this guard
 * cannot judge, so the caller denies those. IPv4-mapped IPv6 literals are left in IPv6 form:
 * `DENIED_RANGES` and the own-address list match them through their embedded entries.
 */
export function canonicalHost(host: string): string | null {
  const bare = stripBrackets(host);
  let parsed: string;
  try {
    parsed = new URL(`http://${isIP(bare) === 6 ? `[${bare}]` : bare}/`).hostname;
  } catch {
    return null;
  }
  const out = stripBrackets(parsed);
  return isIP(out) === 6 ? out : out.replace(/\.$/, "");
}

/**
 * Builds a `BlockList` from `own` (the host's own interface addresses) that matches not just
 * each literal entry but also, for an IPv4 entry, its IPv4-mapped/compatible IPv6 forms (so a
 * server bound to `0.0.0.0` on a host whose own address is `203.0.113.7` is still caught when
 * reached as `::ffff:203.0.113.7` or its hex-group/compatible equivalents), and, for an IPv6
 * entry, with any zone id stripped (interface link-local addresses carry one in
 * `os.networkInterfaces()` on some platforms; the host being checked never does, because
 * `canonicalHost` rejects zone ids). Built fresh per call: `own` is expected to hold at most a
 * handful of interface addresses, so this is cheap, and it keeps this guard a pure function of
 * its two arguments rather than caching across calls with mutable interface state.
 */
function buildOwnBlockList(own: ReadonlySet<string>): BlockList {
  const blockList = new BlockList();
  for (const raw of own) {
    const address = stripZone(stripBrackets(raw).toLowerCase());
    const family = isIP(address);
    if (family === 4) {
      addV4WithEmbedded(blockList, address, 32);
    } else if (family === 6) {
      addV6(blockList, address, 128);
    }
    // An `own` entry that is not a literal IP is not expected (interface addresses always
    // are); silently skip it rather than throw, since this guard must never itself crash the
    // caller over a malformed entry it does not control.
  }
  return blockList;
}

/**
 * Returns a human-readable reason `host` must be denied, or `null` if this guard has no
 * objection to it (a plain public name or address — including a name that merely looks like
 * an IP, such as `10.0.0.1.nip.io`, which this guard leaves to the resolved-address check).
 * Every check runs on `canonicalHost(host)`, the spelling srt actually dials.
 */
export function deniedReason(
  host: string,
  own: ReadonlySet<string>,
): string | null {
  const canonical = canonicalHost(host);
  if (canonical === null) {
    return `'${host}' is not a host name or address the sandbox proxy can canonicalise`;
  }
  const spelled = canonical === host ? `'${host}'` : `'${host}' (${canonical})`;

  const name = canonical.replace(/\.+$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) {
    return `${spelled} is localhost or a *.localhost name`;
  }

  const family = isIP(canonical);
  if (family === 0) {
    // Not an IP literal: a public name (or a name that merely contains an IP-shaped
    // substring, e.g. a nip.io name). The resolved-address check handles this.
    return null;
  }
  const familyName = family === 4 ? "ipv4" : "ipv6";

  if (buildOwnBlockList(own).check(canonical, familyName)) {
    return `${spelled} is an address of the sandbox host's own network interfaces`;
  }

  for (const [blockList, reason] of DENIED_RANGES) {
    if (blockList.check(canonical, familyName)) {
      return `${spelled} ${reason}`;
    }
  }
  return null;
}
