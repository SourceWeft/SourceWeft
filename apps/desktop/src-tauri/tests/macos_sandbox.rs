#![cfg(target_os = "macos")]
//! macOS real-sandbox suite, run through the production `LocalHost` + `dispatch` path against a
//! built `sandbox-sidecar` bundle (copied into `<temp app data>/sandbox/current`, exactly where
//! production looks for it, like `linux_sandbox.rs`). On macOS every command is wrapped by the
//! sidecar through `local_host/srt_exec.rs`, the same path as on Linux: srt's Seatbelt policy plus
//! its proxy, with the sidecar's address guard and read policy (`policy.ts`) on top.
//!
//! Every real test is `#[ignore]` (it needs `sandbox_apply` and the built bundle); run on a real,
//! unrestricted macOS host with:
//!
//!   cargo test --test macos_sandbox -- --include-ignored --test-threads=1
//!
//! `--test-threads=1` because each test starts its own sidecar and the host captures the
//! login-shell `PATH` once per process; the network and readiness probes are also expensive. The
//! bundle is located relative to `CARGO_MANIFEST_DIR` (no new environment variable); build it with
//! `bun run build --rg "$(command -v rg)"` in `apps/desktop/sandbox-sidecar` first.
//!
//! `hostname_to_loopback_blocked` additionally needs two `/etc/hosts` entries,
//! `127.0.0.1 sw-loop.test` and `10.0.0.1 sw-private.test` (the macOS-sandbox CI job adds them),
//! and asserts them, failing with that instruction when they are missing — exactly as
//! `linux_sandbox.rs` does. `public_https_allowed` makes a real request to the public npm
//! registry and fails (never skips) when the host has no working public internet.
mod common;
use common::*;
use serde_json::json;
use sourceweft_desktop::local_host::{
    execution::Executions,
    readiness::{bundle_dir, Remedy, SandboxReadiness, SetupCode},
    LocalHost,
};
use std::{fs, path::Path, sync::Arc, time::Duration};

// ---------------------------------------------------------------------------------------------
// Filesystem: writes and reads inside / outside the workspace.
// ---------------------------------------------------------------------------------------------

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn writes_inside_workspace() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let root = workspace.path.to_str().unwrap().to_string();
    let result = execute(
        &host,
        "write",
        &workspace,
        // BSD `mktemp` with no template ignores `$TMPDIR` (it uses the OS per-process temp dir),
        // so an explicit template under `$TMPDIR` is used to prove temp files land in the
        // workspace's own write-allowed `.tmp`.
        "printf hello > out.txt && /bin/pwd && printf '%s\\n' \"$HOME\" \"$TMPDIR\" \"$npm_config_cache\" \"$PIP_CACHE_DIR\" \"$NODE_USE_ENV_PROXY\" && mktemp \"$TMPDIR/sw.XXXXXX\"",
    );
    let mut keys: Vec<&str> = result
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["cancelled", "exitCode", "output", "truncated"],
        "{result}"
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(result["cancelled"], false, "{result}");
    assert_eq!(result["truncated"], false, "{result}");
    assert_eq!(
        fs::read_to_string(workspace.path.join("out.txt")).unwrap(),
        "hello"
    );
    let lines: Vec<&str> = output(&result).lines().collect();
    assert_eq!(lines[0], root, "pwd: {result}");
    assert_eq!(lines[1], root, "HOME: {result}");
    assert_eq!(lines[2], format!("{root}/.tmp"), "TMPDIR: {result}");
    assert_eq!(
        lines[3],
        format!("{root}/.cache/npm"),
        "npm_config_cache: {result}"
    );
    assert_eq!(
        lines[4],
        format!("{root}/.cache/pip"),
        "PIP_CACHE_DIR: {result}"
    );
    assert_eq!(lines[5], "1", "NODE_USE_ENV_PROXY: {result}");
    assert!(
        lines[6].starts_with(&format!("{root}/.tmp/")),
        "mktemp must land in the workspace TMPDIR: {result}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn cannot_write_outside() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("escape.txt");
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "escape",
        &workspace,
        &format!("printf x > {}", quoted(&target)),
    );
    assert!(
        !target.exists(),
        "a sandboxed command wrote outside its workspace: {result}"
    );
    assert_ne!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn cannot_read_outside() {
    // A planted secret in `$HOME` (outside any workspace) and the real macOS shadow password file
    // `/etc/master.passwd`. Note `/etc/passwd` itself is deliberately world-readable system
    // configuration that the macOS policy re-allows (`DARWIN_SYSTEM_READ_ROOTS` covers `/etc` and
    // `/private/etc`); the secret counterpart is `master.passwd` (mode 0600), which stays denied.
    // `~/.ssh` and a listing of `/Users` must also be denied.
    let home = home_dir();
    let secret_path = home.join(".sw-test-secret");
    let secret = format!("sw-secret-{}", uuid::Uuid::new_v4().simple());
    fs::write(&secret_path, &secret).unwrap();
    let _cleanup = RemoveOnDrop(secret_path.clone());

    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute_denied(
        &host,
        "secrets",
        &workspace,
        &format!(
            "cat {} 2>&1; cat /etc/master.passwd 2>&1; ls {} 2>&1; ls /Users 2>&1",
            quoted(&secret_path),
            quoted(&home.join(".ssh"))
        ),
    );
    assert!(
        !output(&result).contains(&secret),
        "home secret leaked into the sandbox: {result}"
    );
    assert!(
        !output(&result).contains("root:"),
        "/etc/master.passwd contents leaked: {result}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn keychains_are_unreadable() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let home = home_dir();
    // The control only means something if the file exists and is readable outside the sandbox
    // (the system keychain is world-readable on macOS); otherwise the denial below is vacuous.
    let system_keychain = Path::new("/Library/Keychains/System.keychain");
    assert!(
        fs::File::open(system_keychain).is_ok(),
        "precondition: {system_keychain:?} must exist and be readable on the host"
    );
    // ~/Library/Keychains (login keychain) and the system keychain: both denied, and none of
    // their bytes may surface (the system keychain read goes to /dev/null; only a marker prints).
    // No content is written anywhere by this test.
    let result = execute_denied(
        &host,
        "keychains",
        &workspace,
        &format!(
            "ls {} 2>&1; if cat {} >/dev/null 2>&1; then echo SYSTEM-KEYCHAIN-READ; \
             else echo SYSTEM-KEYCHAIN-DENIED; fi",
            quoted(&home.join("Library/Keychains")),
            quoted(system_keychain)
        ),
    );
    assert!(
        output(&result).contains("SYSTEM-KEYCHAIN-DENIED")
            && !output(&result).contains("SYSTEM-KEYCHAIN-READ"),
        "/Library/Keychains/System.keychain was readable: {result}"
    );
    assert!(
        output(&result).contains("Operation not permitted")
            || output(&result).contains("Permission denied"),
        "keychains directory was not denied: {result}"
    );
    // A direct read of the login keychain db file, if present, must also be denied.
    let login = home.join("Library/Keychains/login.keychain-db");
    if login.exists() {
        let r = execute_denied(
            &host,
            "login-kc",
            &workspace,
            &format!("cat {}", quoted(&login)),
        );
        assert_ne!(r["exitCode"], 0, "login keychain was readable: {r}");
    }
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn granted_home_hides_credential_directories() {
    // A user may grant a folder that IS `$HOME`: it then becomes the workspace root and is
    // re-allowed over the home deny. The credential entries (`~/Library/Keychains`, `~/.ssh`,
    // `~/.aws`, `~/.gnupg`) are literal denies that survive that grant. A fake `$HOME` (set before
    // the sidecar starts, restored on drop) keeps the real one out of the test.
    let fake_home = tempfile::tempdir().unwrap();
    let home_path = fake_home.path().canonicalize().unwrap();
    let _home = EnvVarGuard::set("HOME", home_path.to_str().unwrap());
    let planted = [
        ("Library/Keychains/x", "kc-secret-1"),
        (".ssh/id_test", "ssh-secret-2"),
        (".aws/credentials", "aws-secret-3"),
        (".gnupg/x", "gpg-secret-4"),
    ];
    for (relative, secret) in planted {
        let file = home_path.join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, secret).unwrap();
    }
    fs::write(home_path.join("sibling.txt"), "sibling-ok").unwrap();

    let (_app, host) = host_with_bundle();
    let (grant, root) = host.grant_directory("owner", &home_path).unwrap();
    assert_eq!(root, home_path);
    let workspace = host
        .ensure_workspace_with_grant("owner", "thread", Some(&grant))
        .unwrap();
    let result = execute_denied(
        &host,
        "granted-home",
        &workspace,
        // Each probe prints READ:<path> or DENIED:<path>; the sibling is the positive control.
        "for f in Library/Keychains/x .ssh/id_test .aws/credentials .gnupg/x; do \
           if cat \"$f\" >/dev/null 2>&1; then echo \"READ:$f\"; else echo \"DENIED:$f\"; fi; done; \
         cat sibling.txt; echo; cat .ssh/id_test .aws/credentials .gnupg/x Library/Keychains/x 2>&1",
    );
    let text = output(&result);
    for (relative, secret) in planted {
        assert!(
            text.contains(&format!("DENIED:{relative}")),
            "{relative} was readable from a granted home: {result}"
        );
        assert!(!text.contains(secret), "{relative} content leaked: {result}");
    }
    assert!(
        text.contains("sibling-ok"),
        "positive control: a sibling file in the granted home must stay readable: {result}"
    );

    // The same paths are unwritable: a command must not overwrite a key or plant a new file
    // (`authorized_keys`, a second key) inside them. The workspace (= home) itself stays writable.
    let writes = execute_denied(
        &host,
        "granted-home-write",
        &workspace,
        "for f in .ssh/new_key .ssh/authorized_keys .aws/credentials .gnupg/x Library/Keychains/y; do \
           if printf pwned > \"$f\" 2>/dev/null; then echo \"WROTE:$f\"; else echo \"DENIED:$f\"; fi; done; \
         if printf fresh > sibling-new.txt; then echo WROTE-SIBLING; else echo SIBLING-DENIED; fi",
    );
    let text = output(&writes);
    for relative in [
        ".ssh/new_key",
        ".ssh/authorized_keys",
        ".aws/credentials",
        ".gnupg/x",
        "Library/Keychains/y",
    ] {
        assert!(
            text.contains(&format!("DENIED:{relative}")) && !text.contains(&format!("WROTE:{relative}")),
            "{relative} was writable from a granted home: {writes}"
        );
    }
    assert!(
        text.contains("WROTE-SIBLING"),
        "positive control: the granted home itself must stay writable: {writes}"
    );
    // On the host: nothing was created, nothing overwritten, the sibling exists.
    for relative in [".ssh/new_key", ".ssh/authorized_keys", "Library/Keychains/y"] {
        assert!(
            !home_path.join(relative).exists(),
            "{relative} was created inside the credential directory"
        );
    }
    for (relative, secret) in planted {
        assert_eq!(
            fs::read_to_string(home_path.join(relative)).unwrap(),
            secret,
            "{relative} was overwritten"
        );
    }
    assert_eq!(
        fs::read_to_string(home_path.join("sibling-new.txt")).unwrap(),
        "fresh"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn tmp_symlink_workspace() {
    // A workspace whose real location is reached through macOS's firmlinks: `/tmp`→`/private/tmp`
    // (app data created under `/tmp`) and `/var`→`/private/var` (the default `$TMPDIR` app data,
    // under `/private/var/folders`). srt emits both the symlink and resolved spellings, so the
    // sandboxed command must read and write its workspace under either.
    let tmp_app = tempfile::tempdir_in("/tmp").unwrap();
    assert!(
        tmp_app.path().starts_with("/tmp/"),
        "precondition: app data must live under /tmp"
    );
    let host = host_with_bundle_at(tmp_app.path());
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute(
        &host,
        "tmp-ws",
        &workspace,
        // `cat f.txt` has no trailing newline, so `echo` separates it from `/bin/pwd`.
        "printf hi > f.txt && cat f.txt && echo && /bin/pwd",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    let lines: Vec<&str> = output(&result).lines().collect();
    assert_eq!(lines[0], "hi", "workspace read-back: {result}");
    assert!(
        lines[1].starts_with("/private/tmp/"),
        "a workspace under /tmp must resolve through the /private/tmp firmlink: {result}"
    );
    assert_eq!(
        fs::read_to_string(workspace.path.join("f.txt")).unwrap(),
        "hi"
    );

    // The /var→/private/var firmlink: the default app data lives under /private/var/folders.
    let (_app, var_host) = host_with_bundle();
    let var_ws = var_host.ensure_workspace("owner", "thread").unwrap();
    let var_result = execute(&var_host, "var-ws", &var_ws, "printf ok > g.txt && /bin/pwd");
    assert_eq!(var_result["exitCode"], 0, "{var_result}");
    assert!(
        output(&var_result).trim().starts_with("/private/var/"),
        "the default workspace must resolve under /private/var: {var_result}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn external_volume_style_grant() {
    // A folder granted through the native picker that lies entirely outside `$HOME` (an
    // external-volume-style location; here a temp dir under /private/var/folders). It must be a
    // usable workspace, and the keychains must stay hidden even from a workspace outside `$HOME`.
    let (_app, host) = host_with_bundle();
    let outside = tempfile::tempdir().unwrap();
    assert!(
        !outside.path().starts_with(home_dir()),
        "precondition: the granted folder must lie outside $HOME"
    );
    let (grant, root) = host.grant_directory("owner", outside.path()).unwrap();
    let workspace = host
        .ensure_workspace_with_grant("owner", "thread", Some(&grant))
        .unwrap();
    let result = execute(
        &host,
        "granted",
        &workspace,
        // `cat g.txt` has no trailing newline, so `echo` separates it from `/bin/pwd`.
        "printf out > g.txt && cat g.txt && echo && /bin/pwd",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    let lines: Vec<&str> = output(&result).lines().collect();
    assert_eq!(lines[0], "out", "{result}");
    assert_eq!(lines[1], root.to_str().unwrap(), "pwd: {result}");
    assert_eq!(fs::read_to_string(root.join("g.txt")).unwrap(), "out");

    let denied = execute_denied(
        &host,
        "granted-kc",
        &workspace,
        &format!(
            "ls {} 2>&1",
            quoted(&home_dir().join("Library/Keychains"))
        ),
    );
    assert!(
        denied["exitCode"] != 0
            || output(&denied).contains("Operation not permitted")
            || output(&denied).contains("Permission denied"),
        "keychains readable from a granted folder outside home: {denied}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn workspace_with_brackets_and_cjk() {
    let (_app, host) = host_with_bundle();
    // Start the sidecar first with only the automatic workspace base in its init, so the folder
    // granted below is outside that set and forces a restart with the updated roots.
    let automatic = host.ensure_workspace("owner", "first-thread").unwrap();
    let warm = execute(&host, "warm", &automatic, "true");
    assert_eq!(warm["exitCode"], 0, "{warm}");

    let parent = tempfile::tempdir().unwrap();
    let selected = parent.path().join("ws [测试]");
    fs::create_dir(&selected).unwrap();
    let (grant, root) = host.grant_directory("owner", &selected).unwrap();
    let workspace = host
        .ensure_workspace_with_grant("owner", "granted-thread", Some(&grant))
        .unwrap();
    let result = execute(
        &host,
        "granted",
        &workspace,
        "printf ok > 'a [b] 测试.txt' && /bin/pwd",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(output(&result).trim(), root.to_str().unwrap(), "{result}");
    assert_eq!(
        fs::read_to_string(root.join("a [b] 测试.txt")).unwrap(),
        "ok"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn cancel_kills_command() {
    let (_app, host) = host_with_bundle();
    let host = Arc::new(host);
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let executions = Arc::new(Executions::default());
    let worker = {
        let host = host.clone();
        let executions = executions.clone();
        let id = workspace.id.clone();
        std::thread::spawn(move || {
            host.dispatch(
                &executions,
                "cancel-me",
                "owner",
                "thread",
                "command.execute",
                json!({"workspaceId": id, "command": "printf started > started.txt; sleep 20; printf forbidden > after.txt", "timeoutMs": 60000}),
            )
        })
    };
    for _ in 0..1000 {
        if workspace.path.join("started.txt").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        workspace.path.join("started.txt").exists(),
        "command must start before cancellation"
    );
    assert!(executions.cancel("cancel-me"));
    let result = worker.join().unwrap().unwrap();
    assert_eq!(result["cancelled"], true, "{result}");
    // Longer than the remaining `sleep 20` would take if any process survived the group kill.
    std::thread::sleep(Duration::from_secs(1));
    assert!(
        !workspace.path.join("after.txt").exists(),
        "a process survived cancellation: {result}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn toolchain_commands() {
    // The workspace, a system tool (/usr/bin/grep), a login-PATH toolchain (node), python3, and a
    // clang hello-world compile+run, all under the tight read policy. The `/usr/bin` xcode-select
    // shims (`clang`, `python3`, later `git`) resolve their real tool via `xcrun`; with a full
    // `Xcode.app` as the active developer dir that path crashes in the sandbox, so `srt_exec`
    // pins `DEVELOPER_DIR` to the Command Line Tools in the child env — this proves the shims run.
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let build = execute(
        &host,
        "toolchain",
        &workspace,
        "printf hi > f.txt && cat f.txt && /usr/bin/grep -c hi f.txt && \
         node -e 'console.log(\"node\",process.version)' && \
         /usr/bin/python3 --version && \
         printf '#include <stdio.h>\\nint main(){puts(\"clang-ran\");return 0;}\\n' > hello.c && \
         clang hello.c -o hello && ./hello && \
         head -c1 /etc/hosts >/dev/null && echo toolchain-ok",
    );
    assert_eq!(build["exitCode"], 0, "{build}");
    assert!(output(&build).contains("node v"), "node: {build}");
    assert!(output(&build).contains("clang-ran"), "clang: {build}");
    assert!(output(&build).contains("toolchain-ok"), "{build}");
    assert_eq!(fs::read_to_string(workspace.path.join("f.txt")).unwrap(), "hi");

    // git's own `init` cannot populate `.git/hooks` (srt blocks that subtree on every platform —
    // host-executed hook scripts are an escape vector), so the repo is created host-side and the
    // sandbox does the real work through the git shim, which without the DEVELOPER_DIR pin would
    // crash in `xcodebuild` on an Xcode host.
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&workspace.path)
        .status()
        .unwrap();
    assert!(status.success(), "host-side git init failed");
    let commit = execute(
        &host,
        "git",
        &workspace,
        "git -c user.name=T -c user.email=t@example.com add -A && \
         git -c user.name=T -c user.email=t@example.com commit -qm shim && \
         git log --oneline | head -1 >/dev/null && echo git-ran",
    );
    assert_eq!(commit["exitCode"], 0, "{commit}");
    assert!(output(&commit).contains("git-ran"), "{commit}");
}

// ---------------------------------------------------------------------------------------------
// Common-tool read roots (E2E finding): the per-entry `DARWIN_SYSTEM_READ_ROOTS` additions, each
// proved by the real command that failed without it, plus the negative that the narrow entry did
// not re-open the denied directory around it.
// ---------------------------------------------------------------------------------------------

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn perl_backed_tools_run() {
    // `shasum` is a Perl script; `/usr/bin/perl` loads libperl.dylib and its XS modules (Digest::SHA)
    // from `/System/Library/Perl`. Without that read root it aborts with `dyld: Library not loaded:
    // …/libperl.dylib (blocked by sandbox)`, which silently broke skill-staging `shasum -a 256 -c`.
    // The negative control proves the entry is scoped: a sibling `/System/Library/Keychains`
    // (world-readable on the host) stays denied, so `/System/Library` was not blanket-re-allowed.
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    assert!(
        fs::File::open("/System/Library/Keychains").is_ok(),
        "precondition: /System/Library/Keychains must be readable on the host"
    );
    let result = execute(
        &host,
        "perl",
        &workspace,
        "printf 'hi\\n' | shasum -a 256 && printf 'hi\\n' | shasum -a 512 | cut -c1-16 && \
         perl -e 'print \"perl-ran\\n\"' && \
         if ls /System/Library/Keychains >/dev/null 2>&1; then echo SYSLIB-READ; else echo SYSLIB-DENIED; fi",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    let text = output(&result);
    assert!(
        text.contains("98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4"),
        "shasum -a 256 of \"hi\\n\" must print its known digest: {result}"
    );
    assert!(text.contains("d78abb0542736865"), "shasum -a 512 prefix: {result}");
    assert!(text.contains("perl-ran"), "perl -e must run: {result}");
    assert!(
        text.contains("SYSLIB-DENIED") && !text.contains("SYSLIB-READ"),
        "/System/Library/Perl must not re-open sibling /System/Library/Keychains: {result}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn sbin_tools_run() {
    // BSD `md5` lives in `/sbin` (on the login PATH but formerly unreadable, so a bare `md5` was
    // `command not found`). The known MD5 of "hi\n" is asserted so the tool really ran.
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute(&host, "sbin", &workspace, "printf 'hi\\n' | md5");
    assert_eq!(result["exitCode"], 0, "{result}");
    assert!(
        output(&result).contains("764efa883dda1e11db47671c4a3bbd9e"),
        "md5 of \"hi\\n\" must print its known digest: {result}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn usr_share_data_tools_run() {
    // `/usr/share` carries the OS data these tools read: terminfo (`tput`), the file magic database
    // (`file`), and iconv's charset tables. Without it `tput` is `unknown terminal`, `file` reports
    // `could not find any valid magic files`, and `iconv_open` fails with `Invalid argument`.
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute(
        &host,
        "usr-share",
        &workspace,
        "printf '\\x89PNG\\r\\n' > magic.bin && \
         printf 'colors=%s\\n' \"$(TERM=xterm-256color tput colors)\" && \
         file magic.bin && \
         printf 'iconv=%s\\n' \"$(printf 'hi' | iconv -f utf-8 -t utf-8)\"",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    let text = output(&result);
    assert!(text.contains("colors=256"), "tput terminfo lookup: {result}");
    assert!(text.contains("magic.bin:"), "file read its magic database: {result}");
    assert!(text.contains("iconv=hi"), "iconv charset tables: {result}");
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn sw_vers_reads_only_its_version_plist() {
    // `sw_vers` reads `/System/Library/CoreServices/SystemVersion.plist`, re-allowed as a single
    // literal file. The negative control proves the literal did not open the directory: a sibling
    // `Finder.app` (readable on the host) stays denied.
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    assert!(
        fs::File::open("/System/Library/CoreServices/Finder.app").is_ok(),
        "precondition: /System/Library/CoreServices/Finder.app must be readable on the host"
    );
    let result = execute(
        &host,
        "sw-vers",
        &workspace,
        "printf 'version=%s\\n' \"$(sw_vers -productName)\" && \
         if ls /System/Library/CoreServices/Finder.app >/dev/null 2>&1; then echo CS-READ; else echo CS-DENIED; fi",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    let text = output(&result);
    assert!(text.contains("version=macOS"), "sw_vers must read the version plist: {result}");
    assert!(
        text.contains("CS-DENIED") && !text.contains("CS-READ"),
        "the SystemVersion.plist literal must not re-open its directory: {result}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn tz_aware_date_reads_only_timezone_data() {
    // A non-UTC `TZ` makes `date` read the zoneinfo database, which `/usr/share/zoneinfo` symlinks
    // into `/var/db/timezone/…`; the one narrow `/private/var/db/timezone` subpath re-allows it.
    // The negative control proves the rest of the otherwise-denied `/private/var/db` (mode 0755 on
    // the host, so the denial is non-vacuous) — the `dslocal` password-hash store included — stays
    // closed.
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    assert!(
        fs::read_dir("/private/var/db").is_ok(),
        "precondition: /private/var/db must be listable on the host"
    );
    let result = execute(
        &host,
        "tz-date",
        &workspace,
        "printf 'zone=%s\\n' \"$(TZ=America/New_York date +%Z)\" && \
         if ls /private/var/db >/dev/null 2>&1; then echo VARDB-READ; else echo VARDB-DENIED; fi",
    );
    assert_eq!(result["exitCode"], 0, "{result}");
    let text = output(&result);
    assert!(
        text.contains("zone=EST") || text.contains("zone=EDT"),
        "TZ-aware date must resolve the zoneinfo database: {result}"
    );
    assert!(
        text.contains("VARDB-DENIED") && !text.contains("VARDB-READ"),
        "the timezone subpath must not re-open the rest of /private/var/db: {result}"
    );
}

// ---------------------------------------------------------------------------------------------
// Network: the sandbox proxy's address guard (parity with the retired Rust proxy).
// ---------------------------------------------------------------------------------------------

/// Spellings that resolve to a denied address: 127.0.0.1 and its `127.1` shorthand (own
/// loopback), a private RFC1918 literal, and the cloud-metadata link-local literal.
const PRIVATE_LITERALS: [&str; 4] = ["127.0.0.1", "127.1", "10.0.0.1", "169.254.169.254"];

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn private_literal_blocked() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    for spelling in PRIVATE_LITERALS {
        // Direct: srt lists the private ranges in the child's NO_PROXY, so a plain request skips
        // the proxy; Seatbelt then denies the outbound connection (no empty netns on macOS), so it
        // fails to connect. `execute_denied` doubles as the positive control that the shell ran.
        let direct = execute_denied(
            &host,
            &format!("direct-{spelling}"),
            &workspace,
            &format!("curl -sS --max-time 10 -o /dev/null -w %{{http_code}} http://{spelling}/"),
        );
        assert_ne!(direct["exitCode"], 0, "direct {spelling}: {direct}");
        assert!(
            output(&direct).starts_with("000"),
            "a direct connection to {spelling} must fail to connect: {direct}"
        );
        // Proxied: `--noproxy ''` forces the request through the sandbox proxy, whose address
        // guard refuses it with a 403 and a `sandbox_violations` report. The 403 reply is itself
        // the positive control — curl could only receive it by reaching and talking to the proxy.
        let proxied = execute(
            &host,
            &format!("proxied-{spelling}"),
            &workspace,
            &format!(
                "curl -sS --noproxy '' --max-time 10 -o /dev/null -w %{{http_code}} http://{spelling}/"
            ),
        );
        let text = output(&proxied);
        assert!(
            text.contains("403") && text.contains("sandbox_violations"),
            "a private literal address must be refused by the sandbox proxy: {proxied}"
        );
        assert!(
            text.contains("public internet only"),
            "the refusal must come from the address guard: {proxied}"
        );
        assert!(!text.starts_with("200"), "{spelling} must not connect: {proxied}");
    }
}

/// Asserts `/etc/hosts` maps `name` to `address`. The macOS-sandbox CI job adds these entries;
/// without them a hostname test would prove nothing, so it fails with that instruction.
fn require_hosts_entry(name: &str, address: &str) {
    let hosts = fs::read_to_string("/etc/hosts").expect("read /etc/hosts");
    let present = hosts.lines().any(|line| {
        let mut fields = line.split('#').next().unwrap_or_default().split_whitespace();
        fields.next() == Some(address) && fields.any(|field| field == name)
    });
    assert!(
        present,
        "/etc/hosts must map {name} to {address} for this test: add the line \
         `{address} {name}` (the macOS-sandbox CI job does)"
    );
}

#[test]
#[ignore = "requires sandbox_apply, the sandbox bundle and /etc/hosts test entries"]
fn hostname_to_loopback_blocked() {
    require_hosts_entry("sw-loop.test", "127.0.0.1");
    require_hosts_entry("sw-private.test", "10.0.0.1");
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    // `--noproxy ''` forces the request through the sandbox proxy, which resolves the hostname and
    // denies it because it resolves to a loopback / private address.
    for name in ["sw-loop.test", "sw-private.test"] {
        let proxied = execute(
            &host,
            &format!("host-{name}"),
            &workspace,
            &format!(
                "curl -sS --noproxy '' --max-time 10 -o /dev/null -w %{{http_code}} http://{name}/"
            ),
        );
        let text = output(&proxied);
        assert!(
            text.contains("403") && text.contains("sandbox_violations"),
            "a hostname resolving to a private address must be refused: {proxied}"
        );
        assert!(
            text.contains("resolved") || text.contains("public internet only"),
            "the refusal must be a resolved-address denial: {proxied}"
        );
        assert!(
            text.contains(name),
            "the refusal must name the host under test: {proxied}"
        );
        assert!(!text.starts_with("200"), "{name} must not connect: {proxied}");
    }
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn public_https_allowed() {
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute(
        &host,
        "public",
        &workspace,
        "curl -sS -o /dev/null -w %{http_code} https://registry.npmjs.org/left-pad",
    );
    assert_eq!(
        output(&result).trim(),
        "200",
        "a public HTTPS request to the npm registry must return 200; a 000/timeout here means \
         this host has no working public internet. Real public egress is required for this test \
         and must never be skipped or weakened: {result}"
    );
    assert_eq!(result["exitCode"], 0, "{result}");
}

// ---------------------------------------------------------------------------------------------
// Readiness and the sidecar's own environment.
// ---------------------------------------------------------------------------------------------

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn readiness_needs_setup_without_bundle() {
    // No bundle under the app data: macOS must report NeedsSetup with the bundle-missing reason,
    // never Ready (no silent unsandboxed fallback).
    let app = tempfile::tempdir().unwrap();
    let host = LocalHost::open(app.path()).unwrap();
    assert!(!bundle_dir(app.path()).exists());
    // macOS has a published runtime, so the remedy is `downloadRuntime` (Linux's equivalent),
    // which `install_sandbox_runtime` can actually follow — never a downgraded no-download failure.
    let readiness = host.sandbox_readiness();
    assert!(
        matches!(
            readiness,
            SandboxReadiness::NeedsSetup {
                code: SetupCode::BundleMissing,
                remedy: Remedy::DownloadRuntime,
                ..
            }
        ),
        "expected bundleMissing/downloadRuntime, got {readiness:?}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn readiness_ready_with_bundle() {
    // With the bundle installed, the production readiness probe (sidecar `init` + `probe`, which
    // runs a real `sandbox_apply`) reports Ready.
    let (_app, host) = host_with_bundle();
    let readiness = host.sandbox_readiness();
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "expected Ready with the bundle installed, got {readiness:?}"
    );
}

#[test]
#[ignore = "requires sandbox_apply and the sandbox bundle"]
fn proxy_env_stripped() {
    // The parent process has `HTTP_PROXY`/`http_proxy` pointing nowhere. The sidecar is started
    // with a cleared environment and strips any proxy variable before srt loads, so the wrapped
    // command sees only the sandbox's own proxy, never the parent's bogus value.
    let _upper = EnvVarGuard::set("HTTP_PROXY", "http://proxy.invalid.example:9/");
    let _lower = EnvVarGuard::set("http_proxy", "http://proxy.invalid.example:9/");
    let (_app, host) = host_with_bundle();
    let workspace = host.ensure_workspace("owner", "thread").unwrap();
    let result = execute(&host, "proxy-env", &workspace, "env | grep -i proxy || true");
    let text = output(&result);
    assert!(
        !text.contains("proxy.invalid.example"),
        "the parent's HTTP_PROXY leaked into the sandboxed command: {result}"
    );
    // Positive control: the sandbox lays down its own proxy variables, so the command really did
    // observe a proxy configuration (just not the parent's).
    assert!(
        text.to_uppercase().contains("HTTPS_PROXY="),
        "the sandbox must set its own proxy variables: {result}"
    );
}
