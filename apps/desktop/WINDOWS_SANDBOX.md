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
   1. creates `%ProgramFiles%\SourceWeft\sandbox` (administrators write; everyone reads and
      executes) and copies the runtime's `srt-win.exe` into it under a temporary name;
   2. computes the SHA-256 of the **copy** and compares it with the value in the signed
      runtime's manifest. A different file is deleted and the setup stops (exit code 41).
      Nothing has executed it yet;
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

The staged helper must be the same file as the runtime's. After an app or runtime update that
changes `srt-win.exe`, the status becomes **windowsSetupOutdated** and the same button runs the
setup again, which replaces the staged copy. If this computer was set up by a *newer* SourceWeft
than the app, the app asks you to update itself; the setup never goes backwards.

### Remove

There is no button for this yet. To remove everything the setup created, run in an
**administrator** PowerShell, as the same Windows user that uses the app:

```powershell
& "$env:ProgramFiles\SourceWeft\sandbox\srt-win.exe" uninstall
Remove-Item -Recurse -Force "$env:ProgramFiles\SourceWeft\sandbox"
```

`uninstall` removes the network rules, the `sourceweft-sandbox` account, its stored credential
and the setup marker, and first removes the working-folder permissions that were kept for your
user (see [Limits](#limits)). Uninstalling the app does not remove them. The app's own code
path (`LocalHost::run_elevated_uninstall`, used by the CI suite) does the same through the
real UAC launcher. The status then becomes **windowsNotInstalled** and the setup button returns.

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
`.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.cargo\credentials(.toml)`, `.config\gh`,
`.config\gcloud`, `.config\git\credentials`, and under `AppData`: `Roaming\{gcloud, GitHub CLI,
gnupg, Microsoft\Credentials, Microsoft\Protect, Microsoft\Vault, Microsoft\Crypto,
Microsoft\SystemCertificates, Mozilla, 1Password, Bitwarden, KeePass}` and `Local\{Microsoft\Credentials,
Microsoft\Vault, Microsoft\IdentityCache, Microsoft\TokenBroker, Google\Chrome\User Data,
Microsoft\Edge\User Data, BraveSoftware\Brave-Browser\User Data, Packages}` (Windows Credential
Manager stores, DPAPI master keys, browser profiles). Only paths that exist are denied: denying
an absent path would make `srt-win` create a placeholder. A path that appears later is covered by
the next command. The app's own tokens live in the Windows Credential Manager of *your* account
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
the size of the tree).

## What a command can reach on the network

Everything goes through the app's proxy, which allows the public internet only. It refuses
loopback, private (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, ULA), link-local and
cloud-metadata addresses, including shorthand spellings (`127.1`, `2130706433`, `0x7f.0.0.1`,
`10.1`, `2852039166`), and refuses hostnames that *resolve* to such addresses. A command cannot
connect to a server on `localhost` (loopback is open only for the proxy ports; the optional
"allow local binding" mode of upstream stays off).

## The Schannel limitation

Programs built on the Windows **Schannel** TLS stack cannot do HTTPS under the sandbox: Schannel
cannot acquire credentials under the write-restricted token. These fail:

| Fails | Typical symptom |
| --- | --- |
| `C:\Windows\System32\curl.exe` | `curl: (35) schannel: AcquireCredentialsHandle failed` |
| PowerShell `Invoke-WebRequest`, `Invoke-RestMethod` | an exception from the request |
| .NET `HttpClient` / `WebClient` | the same |
| `winget`, `cargo`'s HTTPS downloads | a connection or TLS error |

These work: **Node** (including `fetch`, because `NODE_USE_ENV_PROXY=1` is set), **Python**,
**Java**, **Go**, **git** (Git for Windows' OpenSSL backend, which the sandbox selects for it), and,
in Git Bash, plain **`curl`** (Git's own OpenSSL build, not the System32 one). The runtime prompt
tells the model all of this. The CI suite asserts the failures as a *known limit*
(`schannel_clients_cannot_do_https_under_the_sandbox_known_limit`), with controls proving the same
requests succeed outside the sandbox, so a future `srt` fix is noticed instead of hidden: when
that test starts failing because the clients work, update this section and the prompt.

## Limits

- Reads are ACL-bounded, not deny-by-default: the sandbox account reads what `Users` reads,
  including volumes whose permissions admit `Users`. Nothing in your profile is readable except
  read roots and the working folder.
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
- Working-folder permissions are **kept** after a command ends and removed only by uninstall.
  They name a machine-wide group, so on a **shared computer** another Windows user who runs
  `srt-win exec` by hand without the write-restricted token could write into your working folders.
  Do not use this on a computer that other people have accounts on and who you do not trust.
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
| The sandbox helper in the downloaded runtime does not match its signed manifest. | 41 | The runtime on disk was altered or half-replaced. Install the runtime again. |
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
- Authenticode signing of the runtime's executables (needs the release certificate); CI signs
  with a throwaway certificate and checks that signing leaves them runnable.
- The Credential Manager in a real logon session (CI runs it in a service-like session).
