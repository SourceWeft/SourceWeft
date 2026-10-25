/**
 * Parity of the sidecar's address policy with the retired macOS proxy
 * (`src-tauri/src/local_host/proxy.rs::public_address`, deleted in this migration).
 *
 * The new path judges an address in one of two places, and a class of address must be refused
 * wherever the sandboxed process can reach it:
 *
 * - an IP *literal* host (`curl http://10.0.0.1/`) is judged only by `deniedReason`
 *   (address-guard.ts) in srt's ask callback — srt's own resolved-address check never re-judges
 *   an IP literal (`if (isIP(hostname)) return undefined` in srt's `resolved-address-guard.js`);
 * - a *name* is resolved by srt, which drops every answer in its built-in denied set
 *   (loopback, unspecified `0.0.0.0/8` + `::`, link-local, multicast, broadcast, cloud
 *   metadata, this host's own interface addresses — `DENIED_CLASSES` in srt's
 *   `resolved-address-guard.js`, verified by reading it, and re-verified below by running srt's
 *   guard with NO extra list) or in the config's `deniedResolvedAddresses` (policy.ts), which
 *   must therefore carry everything the built-in set does not: private, CGNAT, ULA,
 *   documentation, reserved and non-global-unicast IPv6.
 *
 * The resolved layer here is srt's real `createResolvedAddressGuard`, fed the real
 * `deniedResolvedAddresses` produced by `buildConfig` — not a re-implementation.
 *
 * Deliberate differences from the old proxy, all pinned below:
 * - 198.18.0.0/15 is allowed (Clash/TUN fake-IP DNS answers public names from it); the old
 *   proxy denied it.
 * - metadata endpoints outside link-local (168.63.129.16, 192.0.0.192, ...) and this host's own
 *   interface addresses are denied; the old proxy only caught them incidentally or not at all.
 * - the IPv4-embedding IPv6 forms (IPv4-compatible, IPv4-translated, NAT64 `64:ff9b::/96`) are
 *   judged by the IPv4 address they carry, as srt does, instead of being denied wholesale for
 *   lying outside 2000::/3; the rest of `::/8` is not listed (see `UNROUTABLE_V6`). The local-use
 *   NAT64 prefix `64:ff9b:1::/48` (RFC 8215) is the exception inside that space: it is refused.
 * - the old proxy only served ports 80/443 and refused a name if ANY of its answers was
 *   non-public; srt serves any port and drops the denied answers, dialing a surviving one.
 *   Neither is an address-class question and neither is tested here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
// Deep import: srt exports no resolved-address guard API. This path (and `createResolvedAddressGuard`)
// is part of the pinned srt fork's layout and must be re-checked and updated whenever the fork is bumped.
import { createResolvedAddressGuard } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import { deniedReason } from "../src/address-guard.js";
import { buildConfig } from "../src/policy.js";

const config = buildConfig({
  platform: "darwin",
  home: "/Users/u",
  workspaceRoots: ["/Users/u/ws"],
  readRoots: [],
  helpers: { ripgrep: "/opt/sw/rg" },
});
const deniedResolvedAddresses = config.network.deniedResolvedAddresses ?? [];

const NAME = "public.example"; // srt only judges *names*; the answer is what varies
const NO_OWN = new Set<string>();
const resolvedWithPolicy = createResolvedAddressGuard({
  deniedResolvedAddresses,
  localAddresses: () => [],
});
const resolvedSrtOnly = createResolvedAddressGuard({ localAddresses: () => [] });

const literalDenied = (address: string): boolean => deniedReason(address, NO_OWN) !== null;
const resolvedDenied = (address: string): boolean => !resolvedWithPolicy.permits(NAME, address, 443);
const srtOnlyDenied = (address: string): boolean => !resolvedSrtOnly.permits(NAME, address, 443);

test("the policy's deniedResolvedAddresses is a valid srt config", () => {
  const parsed = SandboxRuntimeConfigSchema.safeParse(config);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

/**
 * One address class the retired proxy refused. `denied` are the addresses (range edges and
 * typical members) every layer must refuse; `allowed` are the addresses just outside the range
 * that must stay reachable (they pin the range edges against over-blocking). `resolvedBy` says
 * which part of the resolved layer is responsible — and the test proves it, by running srt's
 * guard with no extra list.
 */
type Row = {
  name: string;
  denied: string[];
  allowed?: string[];
  resolvedBy: "srt built-in" | "deniedResolvedAddresses";
};

const CLASSES: Row[] = [
  {
    name: "private 10.0.0.0/8",
    denied: ["10.0.0.0", "10.0.0.1", "10.255.255.255"],
    allowed: ["9.255.255.255", "11.0.0.0"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "private 172.16.0.0/12",
    denied: ["172.16.0.0", "172.20.1.1", "172.31.255.255"],
    allowed: ["172.15.255.255", "172.32.0.0"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "private 192.168.0.0/16",
    denied: ["192.168.0.0", "192.168.1.1", "192.168.255.255"],
    allowed: ["192.167.255.255", "192.169.0.0"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "CGNAT 100.64.0.0/10",
    denied: ["100.64.0.0", "100.64.0.1", "100.127.255.255"],
    allowed: ["100.63.255.255", "100.128.0.0"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "loopback 127.0.0.0/8 and ::1",
    denied: ["127.0.0.0", "127.0.0.1", "127.255.255.255", "::1"],
    allowed: ["126.255.255.255", "128.0.0.0"],
    resolvedBy: "srt built-in",
  },
  {
    name: "link-local 169.254.0.0/16 and fe80::/10",
    denied: [
      "169.254.0.0",
      "169.254.169.254",
      "169.254.255.255",
      "fe80::1",
      "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ],
    allowed: ["169.253.255.255", "169.255.0.0"],
    resolvedBy: "srt built-in",
  },
  {
    name: "broadcast 255.255.255.255",
    denied: ["255.255.255.255"],
    resolvedBy: "srt built-in",
  },
  {
    name: "unspecified / 'this network' 0.0.0.0/8 and ::",
    denied: ["0.0.0.0", "0.0.0.1", "0.255.255.255", "::"],
    allowed: ["1.0.0.0"],
    resolvedBy: "srt built-in",
  },
  {
    name: "multicast 224.0.0.0/4 and ff00::/8",
    denied: ["224.0.0.0", "224.0.0.251", "239.255.255.255", "ff00::1", "ff02::fb"],
    allowed: ["223.255.255.255"],
    resolvedBy: "srt built-in",
  },
  {
    name: "documentation 192.0.2.0/24",
    denied: ["192.0.2.0", "192.0.2.1", "192.0.2.255"],
    allowed: ["192.0.1.255", "192.0.3.0"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "documentation 198.51.100.0/24",
    denied: ["198.51.100.0", "198.51.100.1", "198.51.100.255"],
    allowed: ["198.51.99.255", "198.51.101.0"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "documentation 203.0.113.0/24",
    denied: ["203.0.113.0", "203.0.113.1", "203.0.113.255"],
    allowed: ["203.0.112.255", "203.0.114.0"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "documentation 2001:db8::/32",
    denied: ["2001:db8::", "2001:db8::1", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    allowed: ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    // 255.255.255.255 is in here too (and covered by srt separately, above).
    name: "reserved 240.0.0.0/4",
    denied: ["240.0.0.0", "240.0.0.1", "250.1.2.3", "255.255.255.254"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "unique-local fc00::/7",
    denied: ["fc00::", "fd00::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    name: "IPv6 outside 2000::/3 (everything but ::/8)",
    denied: [
      "100::1", // discard-only 100::/64
      "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // last address below 2000::/3
      "4000::1",
      "8000::1",
      "c000::1",
      "fec0::1", // deprecated site-local
      "fe80::1",
    ],
    allowed: [
      "2000::1", // first block of 2000::/3
      "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // last address of 2000::/3
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ],
    // fe80::1 is srt's; the rest need the policy list, which the "alone" check below pins
    // per address (so this row is checked address by address, not as one class).
    resolvedBy: "deniedResolvedAddresses",
  },
  {
    // The old proxy judged `::ffff:a.b.c.d` by the embedded IPv4 address; so do both layers
    // (BlockList matches the mapped spelling, in dotted and hex-group form, against IPv4 rules).
    name: "IPv4-mapped IPv6 of a loopback/link-local/unspecified address",
    denied: ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:0.0.0.0"],
    resolvedBy: "srt built-in",
  },
  {
    name: "IPv4-mapped IPv6 of a private/CGNAT/documentation/reserved address",
    denied: [
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::ffff:172.16.0.1",
      "::ffff:192.168.1.1",
      "::ffff:100.64.0.1",
      "::ffff:192.0.2.1",
      "::ffff:198.51.100.1",
      "::ffff:203.0.113.1",
      "::ffff:240.0.0.1",
    ],
    resolvedBy: "deniedResolvedAddresses",
  },
];

for (const row of CLASSES) {
  test(`class '${row.name}': refused as a literal and when resolved`, () => {
    for (const address of row.denied) {
      assert.equal(literalDenied(address), true, `literal ${address} must be denied`);
      assert.equal(resolvedDenied(address), true, `resolved ${address} must be denied`);
    }
    for (const address of row.allowed ?? []) {
      assert.equal(literalDenied(address), false, `literal ${address} must be allowed`);
      assert.equal(resolvedDenied(address), false, `resolved ${address} must be allowed`);
    }
  });

  if (row.name.startsWith("IPv6 outside")) continue; // mixed ownership: pinned just below
  test(`class '${row.name}': resolved layer owner is ${row.resolvedBy}`, () => {
    for (const address of row.denied) {
      assert.equal(
        srtOnlyDenied(address),
        row.resolvedBy === "srt built-in",
        `${address}: srt alone ${row.resolvedBy === "srt built-in" ? "must" : "must not"} refuse it`,
      );
    }
  });
}

test("IPv6 outside 2000::/3: fe80::/10 is srt's, the rest rests on deniedResolvedAddresses", () => {
  assert.equal(srtOnlyDenied("fe80::1"), true);
  for (const address of ["100::1", "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "4000::1", "8000::1", "c000::1", "fec0::1"]) {
    assert.equal(srtOnlyDenied(address), false, `${address}: srt alone does not refuse it`);
  }
});

test("cloud metadata endpoints are refused by both layers (srt built-in set)", () => {
  for (const address of [
    "169.254.169.254", // AWS/GCP/Azure/...: link-local
    "100.100.100.200", // Alibaba (also CGNAT)
    "168.63.129.16", // Azure WireServer: neither private nor link-local
    "192.0.0.192", // Oracle Classic: inside the unlisted IETF 192.0.0.0/24
    "fd00:ec2::254", // AWS IPv6 (also ULA)
  ]) {
    assert.equal(literalDenied(address), true, `literal ${address}`);
    assert.equal(resolvedDenied(address), true, `resolved ${address}`);
  }
  // 168.63.129.16 and 192.0.0.192 are in no class the old proxy listed, so only srt's own
  // metadata list protects the resolved layer: pin that, so an srt change cannot go unnoticed.
  assert.equal(srtOnlyDenied("168.63.129.16"), true);
  assert.equal(srtOnlyDenied("192.0.0.192"), true);
});

test("this host's own interface addresses are refused by both layers", () => {
  const own = new Set(["93.184.216.7", "198.18.0.9"]);
  assert.notEqual(deniedReason("198.18.0.9", own), null);
  const guard = createResolvedAddressGuard({
    deniedResolvedAddresses,
    localAddresses: () => ["198.18.0.9"],
  });
  assert.equal(guard.permits(NAME, "198.18.0.9", 443), false);
  // ...and only that address of the range: the rest of 198.18.0.0/15 stays reachable.
  assert.equal(guard.permits(NAME, "198.18.0.10", 443), true);
  assert.equal(deniedReason("198.18.0.10", own), null);
});

test("names: localhost and *.localhost are refused as literals (srt lets only loopback through)", () => {
  for (const host of ["localhost", "LOCALHOST.", "api.localhost"]) {
    assert.notEqual(deniedReason(host, NO_OWN), null, host);
  }
  assert.equal(resolvedWithPolicy.permits("localhost", "8.8.8.8", 443), false);
  assert.equal(resolvedWithPolicy.permits("api.localhost", "8.8.8.8", 443), false);
});

// ---- the deliberate differences ------------------------------------------------------------

test("198.18.0.0/15 stays reachable: Clash/TUN fake-IP DNS answers public names from it", () => {
  // The retired proxy denied it (`a == 198 && (b == 18 || b == 19)`); the migration plan's
  // binding ruling is that the new path must not. See the comment beside the list in policy.ts.
  for (const address of ["198.18.0.0", "198.18.0.1", "198.19.255.255", "::ffff:198.18.0.1"]) {
    assert.equal(literalDenied(address), false, `literal ${address}`);
    assert.equal(resolvedDenied(address), false, `resolved ${address}`);
  }
  assert.ok(!deniedResolvedAddresses.some((entry) => entry.startsWith("198.18.")));
  assert.ok(!deniedResolvedAddresses.some((entry) => entry.startsWith("198.19.")));
});

test("public hosts stay reachable, including NAT64/6to4/IPv6-only answers", () => {
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "192.0.0.1", // IETF 192.0.0.0/24 apart from Oracle's metadata address: old proxy allowed it
    "223.255.255.255",
    "::ffff:8.8.8.8",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2002:808:808::1", // 6to4 of 8.8.8.8
    "64:ff9b::808:808", // NAT64 of 8.8.8.8 (an IPv6-only network's answer for a public name)
  ]) {
    assert.equal(literalDenied(address), false, `literal ${address}`);
    assert.equal(resolvedDenied(address), false, `resolved ${address}`);
  }
});

test("IPv4-embedding IPv6 forms are judged by the IPv4 address they carry, in both layers", () => {
  for (const address of [
    "64:ff9b::a00:1", // NAT64 of 10.0.0.1
    "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
    "64:ff9b::c000:201", // NAT64 of 192.0.2.1 (documentation)
    "64:ff9b::f000:1", // NAT64 of 240.0.0.1 (reserved)
    "2002:a00:1::1", // 6to4 of 10.0.0.1
    "2002:c000:201::1", // 6to4 of 192.0.2.1
    "::a00:1", // IPv4-compatible 10.0.0.1
    "::ffff:0:a00:1", // IPv4-translated 10.0.0.1
  ]) {
    assert.equal(literalDenied(address), true, `literal ${address}`);
    assert.equal(resolvedDenied(address), true, `resolved ${address}`);
  }
});

test("::/8 is not listed wholesale: only addresses that embed a denied IPv4 address are refused", () => {
  // The old proxy refused all of it (outside 2000::/3). Listing it would also refuse NAT64
  // answers for public names (`64:ff9b::/96`), so the rest of ::/8 — reserved space that no
  // public host answers from — is the one place this layer is more permissive than the old.
  for (const address of ["::808:808", "::ffff:0:808:808", "0:1::1"]) {
    assert.equal(literalDenied(address), false, `literal ${address}`);
    assert.equal(resolvedDenied(address), false, `resolved ${address}`);
  }
});

test("the local-use NAT64 prefix 64:ff9b:1::/48 (RFC 8215) is refused whole, in both layers", () => {
  // Its embedded IPv4 address is operator-defined (may be private), so unlike `64:ff9b::/96` it
  // cannot be judged by what it carries. The well-known prefix stays allowed for public IPv4.
  for (const address of ["64:ff9b:1::1", "64:ff9b:1::a00:1", "64:ff9b:1:ffff::808:808"]) {
    assert.equal(literalDenied(address), true, `literal ${address}`);
    assert.equal(resolvedDenied(address), true, `resolved ${address}`);
  }
  assert.equal(literalDenied("64:ff9b::808:808"), false);
  assert.equal(resolvedDenied("64:ff9b::808:808"), false);
});

// ---- exhaustive comparison against a port of the retired Rust function -------------------

type Groups = number[]; // eight 16-bit groups

/** Line-by-line port of `proxy.rs::public_address` (true = the old proxy let it through). */
function oldProxyPublicV4([a, b, c, d]: [number, number, number, number]): boolean {
  void c;
  void d;
  const private10 = a === 10;
  const private172 = a === 172 && b >= 16 && b <= 31;
  const private192 = a === 192 && b === 168;
  const loopback = a === 127;
  const linkLocal = a === 169 && b === 254;
  const broadcast = a === 255 && b === 255 && c === 255 && d === 255;
  const documentation =
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
  const unspecified = a === 0 && b === 0 && c === 0 && d === 0;
  const multicast = a >= 224 && a <= 239;
  return !(
    private10 ||
    private172 ||
    private192 ||
    loopback ||
    linkLocal ||
    broadcast ||
    documentation ||
    unspecified ||
    multicast ||
    a === 0 ||
    a >= 240 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function oldProxyPublic(groups: Groups): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return oldProxyPublicV4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]); // to_ipv4_mapped
  }
  const loopback = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1;
  const unspecified = groups.every((g) => g === 0);
  const multicast = (g0 & 0xff00) === 0xff00;
  return (
    !loopback &&
    !unspecified &&
    !multicast &&
    (g0 & 0xfe00) !== 0xfc00 &&
    (g0 & 0xffc0) !== 0xfe80 &&
    (g0 & 0xe000) === 0x2000 &&
    !(g0 === 0x2001 && g1 === 0x0db8)
  );
}

const v4 = (octets: number[]) => octets.join(".");
const v6 = (groups: Groups) => groups.map((g) => g.toString(16)).join(":");

/** The old proxy's verdict, except the one ruled difference (198.18.0.0/15 is now allowed). */
function expectedPublic(octets: [number, number, number, number]): boolean {
  if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return true;
  return oldProxyPublicV4(octets);
}

test("sweep: every IPv4 /16 (first and last host) matches the old proxy, bar 198.18.0.0/15", () => {
  const mismatches: string[] = [];
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      // Every /16's first and last host, plus the third octets that matter for the three
      // documentation /24s inside 192.0/16, 198.51/16 and 203.0/16.
      const documentation = (a === 192 && b === 0) || (a === 198 && b === 51) || (a === 203 && b === 0);
      const hosts: ReadonlyArray<readonly [number, number]> = documentation
        ? [[0, 0], [2, 1], [100, 1], [113, 1], [255, 255]]
        : [[0, 0], [255, 255]];
      for (const [c, d] of hosts) {
        const octets: [number, number, number, number] = [a, b, c, d];
        const address = v4(octets);
        const want = expectedPublic(octets);
        const literal = !literalDenied(address);
        const resolved = !resolvedDenied(address);
        const mapped = `::ffff:${address}`;
        if (
          literal !== want ||
          resolved !== want ||
          !literalDenied(mapped) !== want ||
          !resolvedDenied(mapped) !== want
        ) {
          mismatches.push(`${address}: want public=${want}, literal=${literal}, resolved=${resolved}`);
        }
      }
    }
  }
  assert.deepEqual(mismatches.slice(0, 20), []);
});

test("sweep: IPv6 across every first group matches the old proxy, bar the embedding forms", () => {
  const mismatches: string[] = [];
  for (let g0 = 0x100; g0 <= 0xffff; g0++) {
    for (const g1 of [0, 0xdb8]) {
      const tail = g0 % 2 === 0 ? [0, 0, 0, 0, 0, 1] : [0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff];
      const groups = [g0, g1, ...tail];
      const address = v6(groups);
      // 6to4 (2002::/16) lies inside 2000::/3, where the old proxy let everything through; srt
      // and address-guard.ts judge it by the IPv4 address in bits 16-47 instead (tested for the
      // refused ones above), so compare against that verdict.
      const want =
        g0 === 0x2002
          ? expectedPublic([g1 >> 8, g1 & 255, (groups[2] ?? 0) >> 8, (groups[2] ?? 0) & 255])
          : oldProxyPublic(groups);
      if (!literalDenied(address) !== want || !resolvedDenied(address) !== want) {
        mismatches.push(
          `${address}: want public=${want}, literal=${!literalDenied(address)}, resolved=${!resolvedDenied(address)}`,
        );
      }
    }
  }
  assert.deepEqual(mismatches.slice(0, 20), []);
});
