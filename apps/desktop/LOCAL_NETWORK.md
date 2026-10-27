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

- The policy is enforced identically on macOS and Linux (both run commands through the sandbox sidecar); Windows does not run local commands yet.
- Attribution assumes one command at a time per device (srt's ask callback carries no
  command id); zero or several concurrently active commands deny everything.
- Setting a request filter makes srt refuse plain-HTTP request targets with dot segments
  or backslashes (400).
