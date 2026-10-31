# Local execution on Windows

This page covers the SourceWeft desktop app on Windows 10 and 11: what local execution is,
the one-time administrator setup and how to remove it, which shell commands run in, what a
command can read, write and reach on the network, the Schannel limitation (and what works
instead), and how to fix each message the app shows.

Everything here describes the code in this repository
(`apps/desktop/sandbox-sidecar/src/policy.ts`,
`apps/desktop/src-tauri/src/local_host/{srt_exec,windows,win_shell,winpath,readiness,privileged_setup}.rs`,
`apps/desktop/src-tauri/resources/windows/sourceweft-sandbox-setup.ps1` and the real-sandbox
suite `apps/desktop/src-tauri/tests/windows_sandbox.rs`). Statements that were derived from
reading the code rather than observed on a real machine are marked **(not run)**; the
[verification](#what-is-verified-and-what-is-not) section says what CI proves.

## What local execution is

With local execution the agent works with files and runs commands on this computer, through
the desktop app, instead of in a remote environment. On Windows every command runs as a
**separate local account** that has no access to your files, with its network and its
writes fenced by Windows itself:

- The command runs as the account `sourceweft-sandbox` (group `sourceweft-sandbox-users`),
  not as you, under a *write-restricted token* inside a Job Object.
- A command can **write** only inside its own working folder. Windows evaluates a second access
  check against the token's restricting SIDs (the sandbox account, `Everyone`, `RESTRICTED` and
  one identifier for the working folder), so rights the account holds only through `Users`
  (for example, creating files in `C:\Windows\Temp`) do not apply.
- A command can **read** what every ordinary account can read (the Windows and Program Files
  folders and so on), its own working folder, and the toolchain folders listed
  [below](#what-a-command-can-read). It cannot read your user profile, your Documents, other
  users' folders, other working folders, or the app's own database.
- Network access goes through a proxy owned by the app and only to the public internet. A
  Windows Filtering Platform rule keyed on the sandbox account's SID refuses every direct
  connection except to the proxy's loopback ports (`60180-60189`).
- If the sandbox cannot start, **nothing runs**. The app never falls back to running a command
  as you. It shows "This computer needs one-time setup" or the reason instead.

The sandbox is the SourceWeft build of Anthropic's `sandbox-runtime` (`srt-win`), with every
machine-wide name (account, registry keys, state folder, firewall sublayer, ports) moved to its
own namespace, so it can sit beside an upstream default install of the same tool without either
reading or changing the other. See [Coexistence](#coexistence-with-the-upstream-srt).

## Requirements

- Windows 10 or later, 64-bit. The installer is x64. On a Windows 11 ARM PC it runs under
  emulation **(not run: nobody has tried the x64 app on ARM)**. The arm64 sandbox runtime is built,
  packed and exercised natively on a `windows-11-arm` CI runner, but the app does not install it.
  Windows 10 itself is **(not run)**; CI uses Windows Server 2025 and Windows 11 ARM images.
- The Secondary Logon service (`seclogon`) must be running: Windows starts the command as the
  sandbox account through it. It is on by default.
- An administrator's approval, once (see [Setup](#one-time-setup)). Windows shows the prompt; the
  app never sees a password.
- A `PATH` that contains your tools. A command's `PATH` is the app's own `PATH` at startup.
- Optional: [Git for Windows](https://gitforwindows.org/) for Git Bash. Without it commands run
  in Windows PowerShell 5.1.

## One-time setup

Open **Settings → This computer**. It shows what is missing; on a fresh install that is these
two steps, in this order:

1. **Install the sandbox runtime** — a signed download (`sourceweft-sandbox-<triple>.tar.gz` and
   its signature) that starts only when you click Install. It unpacks into the app's data folder
   (`%APPDATA%\nicelab.sourceweft\sandbox\current`) and holds the sidecar, `rg.exe`, the proxy
   agent and `srt-win.exe`. That folder is yours to write, so nothing in it ever runs with
   elevated rights or as the sandbox account.
2. **Set up (needs administrator approval)** — one Windows UAC prompt. It runs a PowerShell
   script that is embedded in the app (`sourceweft-sandbox-setup.ps1`, passed to
   `powershell.exe -EncodedCommand`; nothing is read from a file you could change). The script:
   1. asks Windows (not an environment variable) for `Program Files`, stops if that differs from
      what the app expected (exit code 44), checks that `Program Files\SourceWeft` and its
      `sandbox` folder are real folders owned by an administrator account that nobody else can
      write to (exit code 45), creates the `sandbox` folder (administrators write; everyone
      reads and executes) and copies the runtime's `srt-win.exe` into it under a temporary name;
   2. computes the SHA-256 of the **copy** and compares it with the SHA-256 that is **pinned
      inside the app** (`sandbox-sidecar/srt-win-pin.json`, the exact file of the pinned
      `sandbox-runtime` fork release). The runtime's own manifest is not what authorises the
      file: it sits in your writable app data. A different file is deleted and the setup stops
      (exit code 41). Nothing has executed it yet. For the same reason `srt-win.exe` is the one
      executable of the runtime that is **not** Authenticode-signed: signing would change the
      bytes the pin names;
   3. renames the copy into place and runs `srt-win.exe install --proxy-port-range 60180-60189`,
      which creates the `sourceweft-sandbox` account and group and installs the network rules;
   4. writes `%ProgramFiles%\SourceWeft\sandbox-setup-result.json`.

The helper is staged under `Program Files` because the sandbox account itself runs
`srt-win.exe` as the second hop of every launch and cannot read your profile.
`--force` is never used: if a different install of the same names exists, the setup reports it
(exit code 13) and changes nothing.

What the setup does **not** do: it does not change network settings for any account but the
sandbox account (the rules are keyed on that account's SID), does not change any system security
setting, does not grant the sandbox account read access to your profile (upstream's optional
`windows-install` step does that; this app never runs it), and does not run anything that stays
elevated. Your password is never entered into or seen by the app; the UAC dialog is Windows'.

After the setup the app checks again; the status becomes "ready" once a probe command has run
inside the sandbox and Windows has confirmed the network rules block a direct connection.

### Update

The staged helper must be the file pinned in the app (and the runtime's `srt-win.exe` must be
that same file). After an app or runtime update that
changes `srt-win.exe`, the status becomes **windowsSetupOutdated** and the same button runs the
setup again, which replaces the staged copy. If this computer was set up by a *newer* SourceWeft
than the app, the app asks you to update itself; the setup never goes backwards.

### Remove

There is no button for this yet. To remove everything the setup created, run in an
**administrator** PowerShell, as the same Windows user that uses the app. (The app's own removal
path, used by the CI suite, also works when the staged `srt-win.exe` has been deleted: it stages
the pinned, hash-checked helper from the installed runtime first. If the sandbox account exists
and neither helper is available it stops with exit code 46 instead of reporting success. Setup
attempts are rate-limited: a second attempt within 20 seconds of one that did not succeed is
refused without showing a prompt.)

```powershell
& "$env:ProgramFiles\SourceWeft\sandbox\srt-win.exe" uninstall
Remove-Item -Recurse -Force "$env:ProgramFiles\SourceWeft\sandbox"
```

`uninstall` removes the network rules, the `sourceweft-sandbox` account, its stored credential
and the setup marker, and first removes the working-folder permissions that were kept for your
user (see [Limits](#limits)). Uninstalling the app does not remove them. The app's own code
path (`LocalHost::run_elevated_uninstall`, used by the CI suite) does the same through the
real UAC launcher. The status then becomes **windowsNotInstalled** and the setup button returns.

These manual commands do **not** take back the *"this folder only"* permissions the app added on
the folders above your working folders (see
[The folders above a working folder](#the-folders-above-a-working-folder)); only the app's own
removal path does, using `ancestor-grants.json`. After a manual removal those entries stay and
name the deleted sandbox account's SID. They grant nothing to anyone else.

## Which shell commands run in

The shell is chosen by the app; there is no setting.

1. **Git Bash** when `bin\bash.exe` exists in one of Git for Windows' fixed locations:
   `%ProgramFiles%\Git`, `%ProgramW6432%\Git`, `%ProgramFiles(x86)%\Git`,
   `%LOCALAPPDATA%\Programs\Git`.
2. Otherwise **Windows PowerShell 5.1**
   (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`).

Never `cmd.exe`, never PowerShell 7 (`pwsh`), and never a shell found by searching `PATH`: a
writable `PATH` entry must not be able to pick the program that runs as the sandbox account's
shell. The device status reports the shell (`bash` or `powershell`) and the model is told which
one it has, with its quoting rules: POSIX tools and `&&` in Git Bash; single quotes, `;` and
cmdlets in PowerShell 5.1.

Every command starts with a few lines that pin its environment to the working folder, written
in the shell's own syntax and quoted so that nothing in a folder name is interpreted: `HOME`,
`TEMP`, `TMP` (`<folder>\.tmp`), `npm_config_cache` and `PIP_CACHE_DIR` (`<folder>\.cache\...`).
The host's environment never reaches the command; it gets the sandbox account's own profile
environment plus the app's `PATH`/`PATHEXT` and the proxy variables
(`HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1`, git settings). Any proxy
variable that was set when the app started is removed before the sandbox starts.

Paths on the wire between the app and the service are forward-slash drive paths
(`C:/Users/name/project`); both shells accept them.

## What a command can read

Windows has no "deny everything, then allow" mode that is safe to use on a whole drive:
denying `C:\` or your profile would rewrite permissions across a volume. So reads are bounded
by the permissions the sandbox account already has:

- **Readable:** what `Users` can read (Windows, Program Files, ProgramData, most tool
  installations), the command's own working folder, and the *read roots*.
- **Read roots** are exactly the `PATH` directories that lie **inside your profile** (for
  example `~\.cargo\bin`, `~\scoop\shims`, a per-user Python or Node) plus the Git for Windows
  install folder when it is inside the profile. A read root is that directory only: `~\.cargo\bin`
  does not make `~\.cargo\registry` readable. Never a read root: the profile itself, `AppData`
  and its `Local`/`Roaming`/`LocalLow` folders, and the app's data folder.
- **Not readable:** the rest of your profile (Documents, Desktop, Downloads, browser data, other
  working folders, the app's `local-host` database and `sandbox` folder), other users' folders,
  and anything else whose permissions do not admit `Users`.

### Credential stores

Inside the working folder or a read root, these are denied for **both reading and writing**
when they exist: `.ssh`, `.aws`, `.azure`, `.kube`, `.gnupg`, `.docker\config.json`, `.npmrc`,
`.pypirc`, `.netrc`, `_netrc`, `.pgpass`, `.git-credentials`, `.cargo\credentials(.toml)`,
`.m2\settings.xml`, `.gradle\gradle.properties`, `.nuget\NuGet.Config`, `.oci`, `.terraform.d`,
`.claude`, `.codex`, `.config\gh`, `.config\gcloud`, `.config\git\credentials`,
`.config\rclone`, `.config\op`, and under `AppData`: `Roaming\{gcloud, GitHub CLI,
gnupg, Microsoft\Credentials, Microsoft\Protect, Microsoft\Vault, Microsoft\Crypto,
Microsoft\SystemCertificates, Mozilla, 1Password, Bitwarden, KeePass, Code\User\globalStorage,
npm\etc\npmrc}` and `Local\{Microsoft\Credentials,
Microsoft\Vault, Microsoft\IdentityCache, Microsoft\TokenBroker, Google\Chrome\User Data,
Microsoft\Edge\User Data, BraveSoftware\Brave-Browser\User Data, Packages}` (Windows Credential
Manager stores, DPAPI master keys, browser profiles). Only paths that exist are denied: denying
an absent path would make `srt-win` create a placeholder. A path that appears later is covered by
the next command. The list is one file shared by the app and the sandbox process
(`sandbox-sidecar/src/windows-protected-paths.json`). A working folder or read root that **is or
lies inside** one of these (for example `%USERPROFILE%\.ssh\project`) is refused: the denies
only cover what lies *inside* a granted folder, so a folder placed inside a credential store
would be granted with no deny at all. The app's own tokens live in the Windows Credential Manager of *your* account
(size-limited to 2560 bytes per entry), which the sandbox account cannot see.

### Working folders

A folder you add must not be a drive root, your profile folder, `AppData`, or any folder that
contains them; the app refuses it with "Choose a narrower folder", because write access is
granted as a permission on the whole tree and kept until uninstall.

Each working folder gets its own sandbox process (the write permission is per session, and a
command may be re-allowed only its own folder). At most **4** run at once; a fifth workspace
evicts the longest-idle one, and if all four are running commands the new command is refused
with `SANDBOX_BUSY` ("Too many workspaces are running commands at once; wait for one to
finish."). The first command in a folder pays for stamping the permission on it (proportional to
the size of the tree); that first start may take up to 10 minutes before it is reported as
`SANDBOX_INIT_TIMEOUT` ("Preparing this folder for the sandbox did not finish ... Use a smaller
folder, or try again"). It is not treated as a broken sandbox and is not retried automatically.

The readiness check in **Settings → This computer** starts a sandbox of its own the same way, and
the first start after a fresh setup is slow for the same reason (Windows creates the sandbox
account's profile at its first logon). Each check waits up to the same 10 minutes and, while it
times out, the device shows *getting ready* and is checked again. After **3 checks in a row** that
each waited the full time, the state changes to a failure, `SANDBOX_START_INCOMPLETE` ("The sandbox
did not finish its first start ..."), whose message names the setup result file
(`%ProgramFiles%\SourceWeft\sandbox-setup-result.json`). Run the setup again, or remove the sandbox
and set it up again ([Remove](#remove)). A successful check resets the count.

### The folders above a working folder

Programs resolve the path they run in: Node's `realpathSync` and Git `stat` **every parent** of
the working folder. Your profile is closed to the sandbox account, so before a sandbox starts for
a folder the app gives the account one *"this folder only"* permission on each directory above the
working folder (and above each toolchain folder) that lies **inside your profile**, the profile
folder included. The permission is `FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL |
SYNCHRONIZE`: not inherited by anything below it, no listing, no file reads. The drive root,
`C:\Users` and anything outside your profile are readable by default and are not touched.

**What this exposes:** to the sandbox account, that each of those directories exists, its
attributes (dates, flags) and its permission list. **Not exposed:** the names of other entries
(the account cannot list the directory) or any contents. Existing permissions are kept as they
are and the protection flags are never changed; a directory that already admits the account is
left alone, so a second start changes nothing. The entries the app added are recorded in
`%APPDATA%\nicelab.sourceweft\sandbox\ancestor-grants.json` and the app's removal path takes
exactly those back (by the recorded SID, so it works after the account is gone). Without the
account (sandbox not set up) nothing is granted and nothing runs. If a permission list cannot be
written (for example a protected folder), the command is refused naming that folder.

## What a command can reach on the network

Everything goes through the app's proxy, which allows the public internet only. It refuses
loopback, private (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, ULA), link-local and
cloud-metadata addresses, including shorthand spellings (`127.1`, `2130706433`, `0x7f.0.0.1`,
`10.1`, `2852039166`), and refuses hostnames that *resolve* to such addresses. A command cannot
connect to a server on `localhost` (loopback is open only for the proxy ports; the optional
"allow local binding" mode of upstream stays off).

**Network modes and approvals** (`open`, `ask`, `strict`, per computer; see `LOCAL_NETWORK.md`) work
on Windows exactly as on macOS and Linux: the sidecar's proxy decides every connection, an `ask`
raises an approval card in the conversation while the command keeps running, `strict` and the
address guard never ask, and each command's result carries its `networkAudit`. Nothing about them
is Windows-specific except that a command can only reach the network through that proxy (the
firewall rules srt-win installs leave no other route), so a mode that refuses a host cannot be
bypassed by a client that ignores proxy variables. The host attributes asks to the one running
command on the computer; commands running at the same time in different working folders (each
folder has its own sidecar) deny every ask, as documented in `LOCAL_NETWORK.md`. HTTPS request
paths and methods are not visible without TLS termination, so the audit lists HTTPS as
connections only.

## The Schannel limitation

Programs built on the Windows **Schannel** TLS stack cannot do HTTPS under the sandbox: Schannel
cannot acquire credentials under the write-restricted token. This includes **every `curl`**,
because both the System32 `curl.exe` and the `curl` that ships with Git for Windows (the one
plain `curl` runs in Git Bash) are Schannel builds. These fail, in either shell:

| Fails | Typical symptom |
| --- | --- |
| `curl` and `curl.exe`: `C:\Windows\System32\curl.exe` and Git for Windows' `curl` (so plain `curl` in Git Bash too) | `curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` |
| PowerShell `Invoke-WebRequest`, `Invoke-RestMethod` | an exception from the request |
| .NET `HttpClient` / `WebClient` | the same |
| `winget`, `cargo`'s HTTPS downloads | a connection or TLS error |

These work: **Node** (including `fetch`, because `NODE_USE_ENV_PROXY=1` is set), **Python**,
**Java** and **Go** programs, and **git** (Git for Windows' OpenSSL backend, which the sandbox
selects for it, so `git clone`/`fetch` over HTTPS work). For a plain download use
`node -e "fetch(url).then(...)"` or Python's `urllib`, not `curl`. The runtime prompt tells the
model all of this; on a Windows computer it never tells it that `curl` works. The symptom shown
for plain `curl` in Git Bash was observed on the `windows-2025` CI runner. The CI suite asserts
the Schannel failures as a *known limit*, with controls proving the same requests succeed outside
the sandbox, so a future `srt` fix is noticed instead of hidden: when a test starts failing
because a Schannel client works, update this section and the prompt.

## Limits

- **Reads are bounded by permissions, not by a deny list.** The sandbox account reads whatever
  `Users` can read, on every volume: a second drive or a data partition whose permissions admit
  `Users` is readable from a command, and the app cannot narrow that without rewriting
  permissions across the volume. Nothing in your profile is readable except read roots, the
  working folder and what its ancestors expose (below).
- Tools installed under `Program Files` or other `Users`-readable places work without any setup.
  A tool whose directory is outside the profile and not readable by `Users` does not work.
- `rustup` keeps toolchains in `~\.rustup`, which is not on `PATH` and is never granted, so
  `cargo`/`rustc` installed through rustup cannot find their toolchain. A toolchain installed
  elsewhere (for example under `Program Files`, or a standalone install on `PATH`) works.
- Schannel clients fail (above).
- Locations writable by `Everyone` stay writable (an upstream `srt-win` residual: the restricting
  SIDs include `Everyone`). Typical Windows folders are writable by `Users` only, which the
  token blocks.
- At most 4 working folders at a time (above). The setup supports 5 sandbox processes in total
  (ten ports, two each): four folders and the readiness probe.
- **Working-folder permissions are kept until uninstall.** Granting write access to a working
  folder stamps a permission on its whole tree. It stays after the command ends, after you
  remove the folder from the app and after you uninstall the app; only the sandbox removal
  ([Remove](#remove)) takes it back.
- **Working folders are not isolated from each other for reads.** Writes are: a command can write
  only in its own working folder. But a kept write permission also gives the sandbox group read
  access (`srt-win` design: "any sandboxed session can read a kept root"), so a command in one
  working folder can **read** the files of another working folder that was ever used, on this
  computer. There is no per-workspace read separation on Windows, and the app cannot add one (a
  per-command read deny is stamped on the shared sandbox account and would also block a command
  running in the other folder). Your profile, credential directories and the app's own data stay
  protected as described above. The CI suite asserts this limit (reads succeed, writes are
  refused), so an `srt` change is noticed.
- **The staged helper is machine-wide.** `srt-win.exe` lives in `%ProgramFiles%\SourceWeft\sandbox`
  and the sandbox account, its group and the network rules belong to the computer, not to one
  Windows user. On a **shared computer** every Windows user who runs SourceWeft uses the same
  helper, and a user whose app carries a different helper replaces it for all of them (the next
  setup, which needs an administrator, does that). The kept permissions above name the machine-wide
  group, so another Windows user who runs `srt-win exec` by hand, without the write-restricted
  token, could write into your working folders. Do not use this on a computer that other people
  have accounts on and who you do not trust.
- **Ancestors of a working folder are partly exposed.** Programs resolve the path they start in
  (Node's `realpathSync` looks at every parent folder, Git does the same), and the sandbox account
  cannot look at folders inside your profile. So, before the first command in a working folder, the
  app adds for each folder above it (and above each read root) inside your profile, the profile
  folder and `AppData` included, one permission for the sandbox account that applies to that folder
  only: traverse, read attributes and read permissions. It does not allow listing the folder,
  reading any file, or anything inherited by the folders below, and the drive root, `C:\Users`
  and anything outside your profile are not touched. Consequence: a command can see that those
  folders exist and read their attributes and permissions, and can open a path whose name it
  already knows, but cannot list them or learn the names beside them. The app records what it added
  in `<app data>\sandbox\ancestor-grants.json` and takes back exactly those entries when it
  removes the sandbox (its own removal path; the manual commands under [Remove](#remove) do not,
  and uninstalling the app does not either, so until then they stay, naming the sandbox account).
- A process in the sandbox can derive a differently-restricted copy of its own token that the
  network rule does not match (`deny-only-user-sid` residual documented by upstream). The sandbox
  checks for it at start and reports it in its log; it does not fail the session.
- The sandbox account is a local account named `sourceweft-sandbox` with a generated password
  that `srt-win` keeps in its own machine-wide registry key. A policy that forbids creating local
  accounts, or that disables the Secondary Logon service, makes the setup or the commands fail.

## Coexistence with the upstream srt

Anthropic's own CLI installs `srt-sandbox` with ports `60080-60089`. SourceWeft's build uses its
own names: account `sourceweft-sandbox`, group `sourceweft-sandbox-users`, its own registry hive
and state folder, its own firewall sublayer and ports `60180-60189`. The readiness check never
reads or writes upstream's state. The `windows-sandbox` CI job installs the upstream default
first and proves, on both architectures, that both installs work side by side, that SourceWeft's
install, run, tamper repair and removal leave upstream's `status` byte-for-byte unchanged, and
that upstream can then be removed.

## Troubleshooting

The setup writes `%ProgramFiles%\SourceWeft\sandbox-setup-result.json`:
`{"runId": "...", "exit": 12, "message": "..."}`. Only administrators can create that file; the
app ignores a result that does not carry its own run id. `message` is `srt-win`'s own error text
(its last 600 characters) or the script's.

| What the app says | Exit | Meaning and fix |
| --- | --- | --- |
| Authorization was cancelled or denied. | 120 | The UAC prompt was dismissed, or your account cannot approve it. Click Set up again and approve; ask an administrator if you are not one. |
| The sandbox network rules could not be installed. | 12 | Installing the Windows Filtering Platform rules failed. Check that the *Base Filtering Engine* service is running and that no security software blocks changes to it; see `message`. |
| A different sandbox setup already exists on this computer and was not replaced. | 13 | An install with the same names but another port range or settings exists. Remove it (see [Remove](#remove)), then set up again. |
| The sandbox account could not be created. | 14 | A local account policy or a name clash. A principal named `sourceweft-sandbox` that `srt-win` did not create is refused. |
| The sandbox could not protect the system folders. | 17 | `srt-win` could not place the write-deny entries it keeps on system folders; see `message`. |
| A sandboxed command is still running. Stop it and try again. | 22 | A sandbox session is alive. End the running command (or close the workspace) and retry. |
| The setup did not get administrator rights. | 40 | The script ran without elevation. Approve the UAC prompt. |
| The sandbox helper in the downloaded runtime is not the one this version of SourceWeft expects. | 41 | The runtime on disk was altered, half-replaced or belongs to another release. Install the runtime again. |
| Windows reports a different Program Files location than SourceWeft expected, so the setup was stopped. | 44 | The app and the elevated script disagree about where `Program Files` is. Nothing was changed. |
| The folder the sandbox helper is installed in is not protected against changes by ordinary users, so the setup was stopped. | 45 | `Program Files\SourceWeft` (or its `sandbox` folder) already existed and is a link, is owned by an ordinary account, or grants write access to someone who is not an administrator. Fix its permissions; `message` names the entry. (A folder the setup creates itself gets a fixed permission list first: owned by the Administrators group, SYSTEM and administrators full control, Users read and execute, nothing inherited, so a built-in administrator account without a split token does not trip this. Every refusal of the 40s writes the folder's permissions in SDDL form and the process's user, token owner and elevation into the result file's `message`, and the app's error shows the first 600 characters of that file.) |
| The sandbox is set up on this computer but its helper is missing, and the runtime to repair it from is not available. | 46 | A removal found the sandbox account but no `srt-win.exe` to remove it with. Install the runtime again, then remove. |
| The setup could not finish. / could not find the sandbox runtime. | 42 / 43 | Read `message`. For 43 install the runtime first. |
| Windows could not start the setup. | 121 | `powershell.exe` could not start the elevated process (policy, or an automation session without a desktop). Run the app in your normal desktop session. |

Other states in **Settings → This computer**:

- **windowsNotInstalled** — the helper is not staged, the account or the network rules are
  missing. Click *Set up*. After an *Uninstall* this is the expected state.
- **windowsSetupOutdated** — the staged helper differs from the runtime's, or the rules use
  another port range. Click *Set up* again.
- **Runtime not installed / stale / newer** — the same messages as on Linux: install the
  runtime, or update the app.
- **`SANDBOX_UNAVAILABLE`** after the setup — see the message; if it names `seclogon` or
  *Secondary Logon*, start the Secondary Logon service (`sc start seclogon`) **(not run)**.
- **`SANDBOX_BUSY`** — four working folders are running commands; wait for one to finish.
- **`SANDBOX_INIT_TIMEOUT`** — the first start in a working folder (or the first readiness check
  after setup) did not finish within 10 minutes. Shown as *getting ready* and not a failure; use a
  smaller folder, or try again.
- **`SANDBOX_START_INCOMPLETE`** — three readiness checks in a row each waited the full 10 minutes
  for the sandbox's first start. Read `sandbox-setup-result.json`, then run the setup again or
  remove and set up the sandbox again ([Remove](#remove)).
- **A command cannot find a tool** — the tool's folder is outside the profile and not readable
  by `Users`, or inside the profile and not a `PATH` entry. Put its `bin` folder on the `PATH`
  *before starting the app*, or install it for all users.
- **HTTPS fails with a Schannel/TLS error** — see [the limitation](#the-schannel-limitation).

## What is verified and what is not

The `windows-sandbox` job of `.github/workflows/desktop-build.yml` runs
`tests/windows_sandbox.rs` on `windows-2025` (x64) and `windows-11-arm` (arm64): the setup and
the removal through the real launcher, readiness in each state (ready, helper not staged,
helper different from the runtime's, tampered, not installed after removal), writes inside the
working folder, no reads of planted secrets in the profile root and `%USERPROFILE%\.ssh`, no
writes outside, no access to another working folder, credential denies inside a granted folder,
HTTPS through Node and Git, the Schannel limitation, refused loopback/private/metadata/shorthand
addresses over CONNECT and SOCKS and by hostname, cancel and timeout with zero surviving
processes (by pid and by command line), exit codes, the output cap, folder names with spaces,
brackets, CJK and apostrophes, concurrent folders, the cap of four with eviction and
`SANDBOX_BUSY`, poisoned proxy variables, and both shells (Git Bash, then Windows PowerShell).

Not covered by CI, and checked by hand or not at all:

- **A UAC prompt answered by a person.** The runner is an administrator with UAC consent
  disabled, so `Start-Process -Verb RunAs` completes without a prompt: the launcher, the script
  and the result file are exercised, the consent dialog (including Cancel and a standard user
  entering administrator credentials) is not.
- Windows 10, and the x64 app on Windows 11 ARM.
- Git Bash and PowerShell in a real interactive desktop session, with real antivirus and
  SmartScreen.
- Authenticode signing of the runtime's `srt-sidecar.exe` and `rg.exe` (needs the release
  certificate; `srt-win.exe` is pinned by hash instead and never signed); CI signs
  with a throwaway certificate and checks that signing leaves them runnable.
- The Credential Manager in a real logon session (CI runs it in a service-like session).
