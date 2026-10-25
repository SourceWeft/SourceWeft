# Local execution on Linux

This page covers the SourceWeft desktop app on Linux: what local execution is, how to set
it up (`.deb` or AppImage), what the sandbox runtime download does, how to fix each setup
message the app shows, and which toolchains the sandbox can and cannot see.

Everything here describes the code in this repository
(`apps/desktop/sandbox-sidecar/src/policy.ts`,
`apps/desktop/src-tauri/src/local_host/{srt_exec,readiness}.rs` and
`apps/desktop/src-tauri/resources/linux/`). Statements that were derived from reading the
code rather than observed on a real machine are marked **(not run)**.

## What local execution is

With local execution the agent works with files and runs commands on this computer, through
the desktop app, instead of in a remote environment. On Linux every command runs inside a
sandbox ([bubblewrap](https://github.com/containers/bubblewrap) plus a seccomp filter,
driven by a small helper called the sandbox runtime):

- A command can **write** only inside its own working folder.
- A command can **read** only its working folder, the system directories (`/usr`, `/bin`,
  `/sbin`, `/lib*`, `/etc`, `/opt`) and a few toolchain folders under your home directory
  (see [Toolchains](#toolchains-under-the-read-policy)). Your home directory itself, other
  users' homes, `/tmp`, `/var`, `/run`, `/mnt`, `/media`, `/srv` and `/snap` are not readable.
- Network access goes through a proxy owned by the app. Nothing is allowed by default.
- If the sandbox cannot start, **nothing runs**. The app never falls back to running a
  command without it. It shows "This computer needs one-time setup" instead.

## Requirements

- Linux **x86_64**. Other architectures are not supported; Windows reports local execution as
  unavailable.
- A desktop session. The app is a graphical application.
- A Secret Service keyring (GNOME Keyring, KWallet, ...) that is running and unlocked. The
  app keeps this device's credentials there and has no file-based fallback.
- `bubblewrap` and `socat`. The `.deb` declares them as dependencies; with the AppImage you
  install them yourself (`sudo apt install bubblewrap socat` on Debian and Ubuntu).
- For the AppImage: FUSE 2 on most distributions, `pkexec` (polkit) for the one-time
  administrator step, or `sudo` if you prefer to run the printed command yourself.
- Internet access to GitHub Releases once, to download the sandbox runtime.

## Installing with the `.deb` (recommended)

Download `SourceWeft_<version>_linux-x86_64.deb` from the GitHub Release for your version
(signed releases only; pre-release candidates do not carry it), then:

```sh
sudo apt install ./SourceWeft_<version>_linux-x86_64.deb
```

`apt` installs `bubblewrap` and `socat` if they are missing. The package's post-install
step runs `/opt/sourceweft/libexec/sourceweft-sandbox-setup install`, which:

1. Copies `/usr/bin/bwrap` to `/opt/sourceweft/libexec/bwrap` (root-owned, mode 0755).
2. Writes `/etc/apparmor.d/sourceweft-bwrap`, an AppArmor profile that applies **only to
   that path** and permits user namespaces, and loads it with `apparmor_parser -r`. If the
   system has no AppArmor, the copy is still made and no profile is written.

Why a copy: Ubuntu 24.04 and later set `kernel.apparmor_restrict_unprivileged_userns=1`,
which stops ordinary programs, bubblewrap included, from creating the user namespace the
sandbox needs. The usual workaround is to loosen the system-wide setting or to give
`/usr/bin/bwrap` a profile, which affects every program that calls it. SourceWeft instead
gives a private copy its own profile. The script **never** modifies `/usr/bin/bwrap`, any
other AppArmor profile, or any sysctl; the restriction stays in force for everything else.

The same step runs again on every package upgrade, so the copy follows the system
`bubblewrap`. If you update the `bubblewrap` package on its own, the copy is not refreshed
until you reinstall the SourceWeft `.deb` or run
`sudo /opt/sourceweft/libexec/sourceweft-sandbox-setup install`.

If the setup step fails during installation, the package still installs, a message is
printed, and the app reports that it needs setup. Fix the cause and run the command above.

Removing the package (`sudo apt remove sourceweft`, or `purge`) runs the script's
`uninstall` first: it unloads the profile, deletes the profile file and the copy, and
removes `/opt/sourceweft` if it is then empty. An upgrade does not uninstall. The package
name for `apt remove` is what `dpkg-deb -f <file> Package` prints for the file you downloaded.

After installing, open the app, go to **Settings → This computer** and
[install the sandbox runtime](#the-sandbox-runtime-download).

## Installing with the AppImage

The AppImage cannot run package scripts, so the same one-time setup is a separate
administrator step. The app does not do it silently: when `/opt/sourceweft/libexec/bwrap`
is missing, **Settings → This computer** shows "Set up local execution" with the exact
command and two choices:

- **Run setup** opens your system's administrator (polkit) prompt and runs the command. The
  app does not see your password.
- Copy the command (it begins `pkexec /bin/sh -c '...' sourceweft-sandbox-setup install`) and
  run it in a terminal. If `pkexec` is not available, run the same text with `sudo` instead
  of `pkexec`.

It makes the same two changes as the `.deb` (the copy of bubblewrap under
`/opt/sourceweft/libexec`, and its scoped AppArmor profile) and nothing else. Click **Check
again** afterwards, then install the sandbox runtime.

To undo it, run the same command with `uninstall` as its last word instead of `install`
(the script is embedded in the app, so there is no separate file to call), or remove
by hand:

```sh
sudo apparmor_parser -R /etc/apparmor.d/sourceweft-bwrap   # skip if AppArmor is not used
sudo rm -f /etc/apparmor.d/sourceweft-bwrap /opt/sourceweft/libexec/bwrap
sudo rmdir /opt/sourceweft/libexec /opt/sourceweft         # only succeeds when empty
```

The setup is needed even on distributions without the AppArmor restriction, because the
app always runs the copy at `/opt/sourceweft/libexec/bwrap`, never `/usr/bin/bwrap`.

Updating an AppImage does not re-copy bubblewrap. Run the setup again after a
`bubblewrap` package update if you want the copy refreshed.

## The sandbox runtime download

The runtime (the sandbox helper program, a bundled `ripgrep`, the seccomp helper and a Java
proxy agent) is not inside the `.deb` or the AppImage. It is downloaded **only when you
click "Install sandbox runtime"** in **Settings → This computer**. Nothing is downloaded
automatically.

- Source: the GitHub Release asset for exactly this app's version,
  `https://github.com/SourceWeft/SourceWeft/releases/download/v<version>/sourceweft-sandbox-x86_64-unknown-linux-gnu.tar.gz`
  and its `.sig`.
- It is checked before anything is installed: the minisign signature over the whole archive
  is verified with the updater public key built into the app, then the manifest (protocol
  version, app version, target) and the SHA-256 and size of every file. A build that embeds
  no key (development builds, pre-release candidates) cannot verify the download and
  refuses to install it.
- Location: `<app data>/sandbox/current`, normally
  `~/.local/share/nicelab.sourceweft/sandbox/current`. The sandbox cannot read this
  directory.
- Reinstall or repair: click **Install sandbox runtime** again; the existing copy is
  replaced as a whole. Remove: quit the app and delete the `sandbox` directory in the app
  data folder; the app then shows "Sandbox runtime is not installed" until you install it
  again.
- "Out of date": the installed runtime speaks an older internal protocol than this app
  needs (typically left over from an older app version). Install it again.
- "Newer than this app": the installed runtime is newer than the app understands (for
  example after downgrading the app). Update SourceWeft (**Settings → About → Software
  update**).

The download is always the runtime built for the running app version. The app checks an
installed runtime against its internal protocol version, not the app version: a runtime
from an older app keeps working until the protocol changes, and then shows "out of date".

## Troubleshooting by setup code

The card in **Settings → This computer** shows the reason text from the app. The code
behind it, the cause and the fix:

| Code                      | Reason shown (start of text)                                                                           | Cause                                                                                                                                                         | Fix                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundleMissing`           | "Sandbox runtime is not installed"                                                                     | No runtime under the app data folder, or it was deleted.                                                                                                      | Click **Install sandbox runtime**.                                                                                                                                                                                                     |
| `bundleStale`             | "The sandbox runtime is out of date (protocol N, this app needs M)..."                                 | The installed runtime's protocol is older than this app needs.                                                                                                | Click **Install sandbox runtime** to fetch the one for this app version.                                                                                                                                                               |
| `bundleNewer`             | "The sandbox runtime (protocol N) is newer than this app supports..."                                  | The runtime is newer than the app (app was downgraded or not yet updated).                                                                                    | Update SourceWeft in **Settings → About → Software update**, then **Check again**.                                                                                                                                                     |
| `bundleInvalid`           | "sandbox helper not found at <path>"                                                                   | A file inside the installed runtime was removed or damaged.                                                                                                   | Click **Install sandbox runtime** again.                                                                                                                                                                                               |
| `bwrapMissing`            | "The sandbox helper bubblewrap is missing or not executable at /opt/sourceweft/libexec/bwrap"          | The scoped copy does not exist (package removed, setup never run, `/opt` cleaned).                                                                            | `.deb`: `sudo apt install --reinstall ./SourceWeft_<version>_linux-x86_64.deb` (install `bubblewrap` first if `dpkg -s bubblewrap` says it is missing). AppImage: click **Run setup**, or run the shown command, then **Check again**. |
| `userNamespaceRestricted` | the message from `bwrap`, for example `Operation not permitted`, `setting up uid map` or `RTM_NEWADDR` | The kernel refused the user namespace. Usually the scoped AppArmor profile is not loaded (profile file deleted, AppArmor reloaded without it, copy replaced). | Same fix as `bwrapMissing`. To check the profile: `sudo cat /sys/kernel/security/apparmor/profiles \| grep sourceweft-bwrap`; reload it with `sudo apparmor_parser -r /etc/apparmor.d/sourceweft-bwrap`.                               |
| `sandboxFailed`           | the sandbox's own error, verbatim                                                                      | Anything else; the app does not guess.                                                                                                                        | Click **Check again** (the app also re-checks on its own about once a minute). If it persists, report the exact text. "Checking the sandbox runtime" is a transient state while a check runs.                                          |
| `installing`              | "Installing the sandbox runtime"                                                                       | An install is running (possibly started from another window).                                                                                                 | Wait; the buttons are disabled meanwhile.                                                                                                                                                                                              |

If `userNamespaceRestricted` persists after the setup ran and the profile is loaded, the
restriction is something the app deliberately does not change: a kernel that disables
unprivileged user namespaces (for example `kernel.unprivileged_userns_clone=0` or
`user.max_user_namespaces=0`), or a container or confinement layer around the app. SourceWeft
never edits sysctls; enable user namespaces yourself if you accept that, or use another
machine.

Errors from the install button itself are shown verbatim under the button. The host uses
stable codes: `SANDBOX_DOWNLOAD_FAILED` (could not fetch the release asset: no network, or
the release has no runtime for this version), `SANDBOX_SIGNATURE_INVALID` (the download does
not match the signature; it was not installed), `SANDBOX_BUNDLE_INVALID` (the archive or its
manifest failed validation), `SANDBOX_UNVERIFIABLE_BUILD` (this build has no embedded public
key) **(not run)**.

## Toolchains under the read policy

The read policy is deliberately narrow, so the first question for any tool is "where does
it live, and where does it look for its own files". The facts below come from
`policy.ts` and `srt_exec.rs`.

### What a command can read

| Location                                                                                                | Readable?                                 |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| The command's own working folder                                                                        | Yes (and writable)                        |
| `/usr` (including `/usr/local`), `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/libx32`, `/etc`, `/opt` | Yes                                       |
| `PATH` entries under `$HOME` (below)                                                                    | Yes, the derived folder only              |
| `$HOME` itself, `~/.local`, other users' homes, `/root`                                                 | No                                        |
| `/tmp`, `/var`, `/run`, `/mnt`, `/media`, `/srv`, `/boot`, `/snap`                                      | No                                        |
| Granted folders other than this command's own                                                           | No                                        |
| The app's own data folder (`local-host`, `sandbox`)                                                     | No, even if it is under a readable folder |

Denied locations may look empty or missing rather than raising a clear permission error;
the exact message depends on the tool **(not run)**.

### Where the `PATH` comes from

The app asks your login shell once, when it starts: `$SHELL -lc 'echo $PATH'` (`/bin/sh` if
`$SHELL` is unset), waiting at most five seconds. That is a non-interactive login shell,
which matters:

- Only files read by login shells are applied. For bash that is `/etc/profile` and the first
  of `~/.bash_profile`, `~/.bash_login`, `~/.profile`; for zsh it is `~/.zshenv`,
  `~/.zprofile` and `~/.zlogin`. Lines that only run for interactive shells (most of
  `~/.bashrc`, and all of `~/.zshrc`) are **not** applied. Installers of nvm, pyenv, sdkman
  and similar tools often append their `PATH` setup to those interactive files; if so, move
  or repeat the `export PATH=...` line in the login-shell file.
- If the shell fails, exits non-zero, prints no `PATH`, or takes longer than five seconds,
  the app uses `/usr/local/bin:/usr/bin:/bin` and your own toolchains are not found. Keep
  login profiles fast.
- The result is cached for the life of the app. **Restart the app** after changing a profile.

The command then runs with an environment built by the app, not yours: that `PATH`;
`HOME` set to the command's working folder; `TMPDIR` set to a folder inside it; npm and pip
caches under `<working folder>/.cache`; and the sandbox's proxy variables. Variables such as
`RUSTUP_HOME`, `CARGO_HOME`, `PYENV_ROOT`, `NVM_DIR`, `JAVA_HOME`, `GOPATH`, `SDKMAN_DIR`
and `VOLTA_HOME` are **not** passed on, and a tool that looks for its files under `$HOME`
looks inside the working folder. Shell functions (`nvm`, `sdk`, `conda activate`, ...) do not
exist inside a command.

### Which `PATH` entries become readable

For each `PATH` entry that is an absolute path **under your home directory**:

- If it ends in `/bin`, its **parent** folder is readable (`~/.cargo/bin` makes `~/.cargo`
  readable, so a toolchain's libraries beside its `bin` are found). Otherwise the entry
  itself is readable.
- Exceptions: `~/bin` and `~/.local/bin` make only that folder readable (never `~` or
  `~/.local`). A folder that is, contains or lies inside the app's data folder is skipped.
  Entries that do not exist, are not directories, or are `$HOME` itself are skipped.
- Symlinks are resolved first and the resolved folder is what is allowed.

Entries **outside** `$HOME` are not made readable by this rule; only the system directories
above are. A `PATH` entry that points into an unreadable place stays on `PATH`, but the
programs in it cannot be found or run.

Credential files stay unreadable even inside a folder made readable this way:
`~/.cargo/credentials`, `~/.cargo/credentials.toml`, `~/.docker/config.json`, `~/.npmrc`,
`~/.pypirc`, `~/.netrc`, `~/.git-credentials` and `~/.config/gh/hosts.yml`. Everything else
under `$HOME` that is not under a readable folder (including `~/.ssh`, `~/.aws`, `~/.gnupg`
and `~/.config`) cannot be read at all, so `git` over SSH and cloud CLIs that rely on those
files do not work inside the sandbox.

### Cases

**Distro packages (`apt`, `dnf`, ...).** Work. Everything under `/usr`, `/bin` and `/etc` is
readable. Also fine: tarball installs under `/usr/local` or `/opt` (for example
`/opt/node/bin` or `/usr/local/go/bin`) as long as they are on the `PATH`.

**Linuxbrew at the default prefix `/home/linuxbrew/.linuxbrew`: does not work.** The prefix
is outside `$HOME` and outside the system set, and `/home` is not readable. There is no
setting to add a read folder. What does work: install the tool with your distro's package
manager, or put the toolchain under a folder in your home directory that is on the login
`PATH` (an official tarball in `~/tools/x/bin`, say). Homebrew installed under your home
(`~/.linuxbrew`, with `~/.linuxbrew/bin` on the login `PATH`) is readable by the rule above
**(not run)**; Homebrew itself documents non-default prefixes as unsupported, so most
packages then build from source.

**`/snap/bin` (snap packages): does not work.** `/snap` is not readable, so snap-installed
tools (including a snap `node`, `go`, `code`) cannot be found or run. Install the tool from
the distro's packages or from an upstream tarball instead.

**rustup and cargo.** `~/.cargo/bin` on the login `PATH` makes `~/.cargo` readable, so
binaries installed with `cargo install` run. But `cargo`, `rustc` and `rustup` there are
rustup shims, which look for toolchains in `$RUSTUP_HOME` or `~/.rustup`: that variable is
not passed on, `HOME` is the working folder, and `~/.rustup` is not readable. **The shims do
not work today.** What does work **(not run)**: put the toolchain's own `bin` on the login
`PATH`, ahead of `~/.cargo/bin`:

```sh
# ~/.profile (bash) or ~/.zprofile (zsh)
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$HOME/.cargo/bin:$PATH"
```

Then `~/.rustup/toolchains/stable-x86_64-unknown-linux-gnu` is readable and `cargo` and
`rustc` run from it directly. Use the toolchain folder name that
`ls ~/.rustup/toolchains` shows. Cargo's registry and `target` live in the working folder
(`CARGO_HOME` defaults to `$HOME/.cargo`, which is the working folder), so crates are
downloaded again per folder and need the network to be allowed. A distro `rustc`/`cargo`
from `apt` also works.

**pyenv.** The shims (`~/.pyenv/shims`) call back into pyenv and its `versions` folder; the
shim folder alone is readable, and `PYENV_ROOT` is not passed on, so shims are unreliable.
Use the interpreter's own `bin` instead **(not run)**:
`export PATH="$HOME/.pyenv/versions/3.12.4/bin:$PATH"` in the login profile makes
`~/.pyenv/versions/3.12.4` readable. System Python (`/usr/bin/python3`) works.

**nvm.** The `nvm` function is not available inside commands, so the version cannot be
switched there. The Node version that was active when your login shell started works if its
`bin` is on the login `PATH`: `~/.nvm/versions/node/v20.x.y/bin` makes
`~/.nvm/versions/node/v20.x.y` readable, which holds `node`, `npm` and `npx`. nvm's default
install writes its `PATH` setup to `~/.bashrc`/`~/.zshrc`; as explained above that is not
seen, so add an explicit `export PATH` for the version you want to a login-shell file.
`npm install -g` cannot write to that folder (it is read-only); install into the project, or
use `npx`.

**`pip install --user` and `~/.local`.** `~/.local` is never readable, and `HOME` is the
working folder, so Python's user site is `<working folder>/.local/...`. Packages you
installed earlier with `pip install --user`, and pipx or `uv tool` environments, are not
visible, and the entry scripts in `~/.local/bin` (if that folder is on the `PATH`; only the
folder itself is readable) that need those packages fail. Self-contained binaries there
(`uv`, `ruff` from their standalone installers) do run. For Python work, create a virtual
environment inside the working folder (`python3 -m venv .venv && .venv/bin/pip install ...`),
which is writable, or use `apt` packages.

**sdkman.** Candidate folders such as `~/.sdkman/candidates/java/current/bin` become
readable (the `current` link is resolved, so the real version folder is allowed) if they are
on the login `PATH`. `sdk` itself is a shell function and is not available; `JAVA_HOME` is
not set, but `java` finds its own runtime next to itself. sdkman's init is normally in
`~/.bashrc`; see the `PATH` section. Maven and Gradle use `$HOME/.m2` and `$HOME/.gradle`,
which is the working folder, so dependencies are downloaded again per folder.

**asdf, mise, volta, fnm, conda, other managers.** Not checked. They follow the same rules:
only `PATH` entries are readable (shim folders alone are not enough if the shims call back
into the manager's own data folder), nothing set up by shell functions or environment
variables survives, and anything that looks under `$HOME` looks in the working folder. Put
the real tool directory (a version folder's `bin`) on the login `PATH`.

**Credentials.** The files listed above are unreadable by design. For private package
registries or git hosting, nothing from your home directory is available inside the sandbox.

## What is not possible today

- Reading anything outside the system directories and the derived `$HOME` folders, with no
  setting to add folders. This is why Linuxbrew at its default prefix, snap packages,
  `~/.local` data (`pip --user`, pipx, `uv tool`, mise installs) and rustup shims do not work.
- Passing environment variables (`RUSTUP_HOME`, `PYENV_ROOT`, `JAVA_HOME`, ...) or shell
  functions into commands.
- Running without the sandbox if it cannot start.
