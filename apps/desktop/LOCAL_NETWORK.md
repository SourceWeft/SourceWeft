# Local command network policy

Commands run by the desktop local host reach the network only through the sandbox
sidecar's proxy (`sandbox-sidecar`, wrapping Anthropic's sandbox-runtime). Every
connection is decided in the sidecar; nothing in this file applies to cloud sandboxes.

## Modes (per device, `local_devices.network_mode`, default `ask`)

| Mode | Behaviour |
|---|---|
| `open` | Any public host. This was the behaviour before network approvals. |
| `ask` | Hosts matching an allow rule or a trusted skill's `network-domains` connect directly. Any other host pauses the connection and raises an approval card in the conversation while the command keeps running. |
| `strict` | Only allow rules and trusted-skill domains connect. Nothing is ever prompted. |

The mode can only be changed from the desktop app (native proof), like the other local
settings.

## What no mode or approval can override

The private-address guard runs first, in every mode: `localhost`, `*.localhost`,
loopback, RFC1918, CGNAT, link-local, multicast, cloud-metadata addresses, IPv4-mapped /
compatible forms of those (including shorthand, integer and hex spellings) and every
address on the host's own interfaces are denied. srt re-checks the resolved addresses
after DNS. An allow rule or an "allow" answer for such a host is ignored.

## Approvals

- The sidecar sends an `ask` event; the host relays it to the backend over the device
  WebSocket (`network.ask`); the web app shows the card while the run is active; the
  answer returns as `network.decision`. The backend window is 120 s, the host and the
  sidecar give up at 150 s. A timeout is a denial.
- "Allow once" lasts for the current command. "Allow for this workspace" stores a trust
  rule (`agent_tool_trust_rules`, domain `network`, target = host, all ports) for the
  chosen duration; it needs the workspace-admin approve permission. Rules are listed
  and revocable in the approvals settings.
- A denial reaches the model as a `<sandbox_violations>` line with the reason, and is
  cached for the rest of the command so a retry loop does not re-prompt.
- At most 5 approvals can be pending per command; a command that touches more distinct
  hosts has the rest denied immediately.

## Audit

Each command's result JSON carries `networkAudit`: one entry per connection decision
(host, port, allow/deny, source `open|rule|approval|user|strict|guard|limit|…`, reason)
and one per plain-HTTP request (method, path without query, status). HTTPS request
method/path/status are not visible without TLS termination (Plan 5).
The audit is stored with the invocation result; it is not exposed in the UI yet.

## Known limits

- macOS keeps its Seatbelt proxy until the sidecar switch and ignores the policy.
- Attribution assumes one command at a time per device (srt's ask callback carries no
  command id); zero or several concurrently active commands deny everything.
- Setting a request filter makes srt refuse plain-HTTP request targets with dot segments
  or backslashes (400).

## Secrets for local commands (Plan 5)

The device keychain (`sourceweft-local-vault`) can hold secrets that commands use without
ever seeing them. Metadata (label, env var name, exact bound hosts, read-only flag) lives
in the host's SQLite; values live only in the OS keychain. Management is desktop-only
(`vault_list` returns metadata, never values). macOS stores secrets but does not inject
them until the sidecar switch.

- A command gets `ENV_VAR=fake_value_…` placeholders. The sidecar's TLS-terminating
  proxy replaces the placeholder with the real value in headers (and bodies) **only** on
  requests to the secret's exact bound hosts. Everything else receives the placeholder.
- Bound hosts are exact hostnames (no wildcards), at most 50 per secret and 200 per vault,
  and are reachable even in `ask`/`strict` mode.
- With "require approval for writes" on (default), any request to a bound host other than
  GET/HEAD/OPTIONS asks the user; an approval covers that exact method and path for the
  rest of the command. A request whose body contains a placeholder always asks.
- TLS interception is active only while the vault holds a secret. It uses a persistent
  local CA under `<app data>/sandbox/ca` (key unreadable inside the sandbox) and decrypts
  all HTTPS of sandboxed commands except hosts the proxy cannot terminate. Tools that pin
  certificates may fail. Basic-auth/base64 credentials and URL-embedded secrets are not
  substituted. An upstream that reflects request headers back returns the real value.
- A locked or unavailable keychain does not fail commands: they run without secrets and
  the result carries `vaultWarning`.
