/**
 * Local guard against SSRF-style escapes to the sandboxed process's own host or to a
 * private/internal network, independent of whatever srt's own network config denies. This
 * is the full policy from the design's Global Constraints: localhost names, loopback,
 * RFC1918, CGNAT, link-local, multicast, well-known cloud metadata addresses, the IPv6
 * unique-local range, the unspecified address, and — via `own` — every address bound to the
 * sandbox host's own network interfaces.
 *
 * `host` may be a bare hostname, a bare IPv4/IPv6 literal, or a bracketed IPv6 literal
 * (`[::1]`). A hostname that is not `localhost`/`*.localhost` is left alone here — the caller
 * resolves it and re-checks the resolved address (srt's `deniedResolvedAddresses` is the
 * last line of defense for that).
 */
import { BlockList, isIP } from "node:net";

function addV4(blockList: BlockList, address: string, prefix?: number): void {
  if (prefix === undefined) blockList.addAddress(address, "ipv4");
  else blockList.addSubnet(address, prefix, "ipv4");
}

function addV6(blockList: BlockList, address: string, prefix?: number): void {
  if (prefix === undefined) blockList.addAddress(address, "ipv6");
  else blockList.addSubnet(address, prefix, "ipv6");
}

const LOOPBACK_V4 = new BlockList();
addV4(LOOPBACK_V4, "127.0.0.0", 8);

const LOOPBACK_V6 = new BlockList();
addV6(LOOPBACK_V6, "::1", 128);

const RFC1918 = new BlockList();
addV4(RFC1918, "10.0.0.0", 8);
addV4(RFC1918, "172.16.0.0", 12);
addV4(RFC1918, "192.168.0.0", 16);

const CGNAT = new BlockList();
addV4(CGNAT, "100.64.0.0", 10);

const LINK_LOCAL_V4 = new BlockList();
addV4(LINK_LOCAL_V4, "169.254.0.0", 16);

const LINK_LOCAL_V6 = new BlockList();
addV6(LINK_LOCAL_V6, "fe80::", 10);

const MULTICAST_V4 = new BlockList();
addV4(MULTICAST_V4, "224.0.0.0", 4);

const MULTICAST_V6 = new BlockList();
addV6(MULTICAST_V6, "ff00::", 8);

// fc00::/7 (unique local) — also covers the fd00:ec2::/32 AWS metadata range below, kept as
// its own explicit entry for clarity rather than relying only on the wider range.
const UNIQUE_LOCAL_V6 = new BlockList();
addV6(UNIQUE_LOCAL_V6, "fc00::", 7);

const CLOUD_METADATA_V4 = new BlockList();
addV4(CLOUD_METADATA_V4, "169.254.169.254"); // AWS/GCP/Azure/etc. (also link-local)
addV4(CLOUD_METADATA_V4, "100.100.100.200"); // Alibaba Cloud (also CGNAT)
addV4(CLOUD_METADATA_V4, "168.63.129.16"); // Azure host endpoint
addV4(CLOUD_METADATA_V4, "192.0.0.192"); // Oracle Cloud

const CLOUD_METADATA_V6 = new BlockList();
addV6(CLOUD_METADATA_V6, "fd00:ec2::", 32); // AWS IPv6 metadata

const UNSPECIFIED_V4 = new BlockList();
addV4(UNSPECIFIED_V4, "0.0.0.0");

const UNSPECIFIED_V6 = new BlockList();
addV6(UNSPECIFIED_V6, "::", 128);

function hexGroupToBytes(group: string): [number, number] {
  const value = Number.parseInt(group, 16);
  return [(value >> 8) & 0xff, value & 0xff];
}

/**
 * Maps `::ffff:a.b.c.d`, `::ffff:XXXX:XXXX` (IPv4-mapped) and `::a.b.c.d` (the deprecated
 * IPv4-compatible form) to their IPv4 dotted-quad equivalent. Returns `null` for any other
 * IPv6 literal (including plain `::1`, which is not one of these forms).
 */
function mapIPv4EmbeddedAddress(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (dotted) return dotted[1] as string;

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const [a, b] = hexGroupToBytes(hex[1] as string);
    const [c, d] = hexGroupToBytes(hex[2] as string);
    return `${a}.${b}.${c}.${d}`;
  }

  const compat = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (compat) return compat[1] as string;

  return null;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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
  const stripped = stripBrackets(host);
  const lower = stripped.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return `'${host}' is localhost or a *.localhost name`;
  }

  const family = isIP(stripped);
  if (family === 0) {
    // Not an IP literal: a public name (or a name that merely contains an IP-shaped
    // substring, e.g. a nip.io name). The resolved-address check handles this.
    return null;
  }

  let address = stripped;
  let isV4 = family === 4;
  if (family === 6) {
    const mapped = mapIPv4EmbeddedAddress(stripped);
    if (mapped !== null) {
      address = mapped;
      isV4 = true;
    }
  }

  for (const addr of own) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      return `'${host}' is an address of the sandbox host's own network interfaces`;
    }
  }

  if (isV4) {
    if (UNSPECIFIED_V4.check(address, "ipv4"))
      return `'${host}' is the unspecified address`;
    if (LOOPBACK_V4.check(address, "ipv4"))
      return `'${host}' is a loopback address`;
    if (RFC1918.check(address, "ipv4"))
      return `'${host}' is a private (RFC1918) address`;
    if (CGNAT.check(address, "ipv4"))
      return `'${host}' is a CGNAT (100.64.0.0/10) address`;
    if (LINK_LOCAL_V4.check(address, "ipv4"))
      return `'${host}' is a link-local address`;
    if (MULTICAST_V4.check(address, "ipv4"))
      return `'${host}' is a multicast address`;
    if (CLOUD_METADATA_V4.check(address, "ipv4"))
      return `'${host}' is a well-known cloud metadata address`;
    return null;
  }

  if (UNSPECIFIED_V6.check(address, "ipv6"))
    return `'${host}' is the unspecified address`;
  if (LOOPBACK_V6.check(address, "ipv6"))
    return `'${host}' is a loopback address`;
  if (LINK_LOCAL_V6.check(address, "ipv6"))
    return `'${host}' is a link-local address`;
  if (MULTICAST_V6.check(address, "ipv6"))
    return `'${host}' is a multicast address`;
  if (CLOUD_METADATA_V6.check(address, "ipv6"))
    return `'${host}' is a well-known cloud metadata address`;
  if (UNIQUE_LOCAL_V6.check(address, "ipv6"))
    return `'${host}' is a unique-local (fc00::/7) address`;
  return null;
}
