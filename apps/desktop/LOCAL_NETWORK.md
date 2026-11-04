# Local command network policy

Commands run by the desktop local host reach the network only through the sandbox
sidecar's proxy (`sandbox-sidecar`, wrapping Anthropic's sandbox-runtime). Every
connection is decided in the sidecar; nothing in this file applies to cloud sandboxes.

## Modes (per device, `local_devices.network_mode`, default `open`)

| Mode | Behaviour |
|---|---|
| `open` (default) | Any public host. This is today's behaviour; a device that never chose a mode stays here. |
| `ask` | Hosts matching an allow rule or a trusted skill's `network-domains` connect directly. Any other host pauses the connection and raises an approval card in the conversation while the command keeps running. |
| `strict` | Only allow rules and trusted-skill domains connect. Nothing is ever prompted. |

`ask` and `strict` are opt-ins per device. The mode can only be changed from the desktop
app (native proof), like the other local settings. The model is told which mode applies
(the runtime prompt only mentions approvals in `ask` mode).

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

- The policy is enforced identically on macOS, Linux and Windows: all three run commands through the sandbox sidecar, whose proxy decides every connection. On Windows the sandbox's firewall rules (srt-win) leave the proxy as the only reachable address, and the Windows suite repeats the ask, strict, rule and guard tests (`tests/windows_sandbox.rs`). Windows runs one sidecar per working folder, but the host still treats every running command on the device as one pool for attribution (see the next limit).
- Attribution assumes one command at a time per device (srt's ask callback carries no
  command id); zero or several concurrently active commands deny everything.
- Setting a request filter makes srt refuse plain-HTTP request targets with dot segments
  or backslashes (400).
