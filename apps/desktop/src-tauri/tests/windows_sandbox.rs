#![cfg(windows)]
//! Windows real-sandbox suite: the namespaced `srt-win` (account `sourceweft-sandbox`, WFP rules,
//! write-restricted token), the staged helper under `Program Files`, the elevated setup and the
//! readiness it feeds, all driven through the production `LocalHost::open` + `dispatch` path
//! against a built `sandbox-sidecar` bundle. Every test is `#[ignore]`: it needs the bundle and
//! changes the machine (an account, firewall rules, ACLs). Run it on a disposable machine, which
//! is what the `windows-sandbox` CI job provides (`windows-2025` and `windows-11-arm`):
//!
//!   cargo test --locked --test windows_sandbox -- --include-ignored --test-threads=1
//!
//! `--test-threads=1` is required: the tests install and uninstall machine-wide state, each starts
//! its own sidecars on a fixed loopback port range (60180-60189), and the host captures `PATH`
//! once per process.
//!
//! # What the job provides and the tests demand (each is asserted, with the fix named)
//!
//! - The bundle at `apps/desktop/sandbox-sidecar/dist/bundle` (located relative to
//!   `CARGO_MANIFEST_DIR`; no environment variable locates anything), copied into
//!   `<temp app data>/sandbox/current`, exactly where production looks for it.
//! - An administrator account with UAC consent disabled. The setup tests call
//!   `LocalHost::run_elevated_setup` / `run_elevated_uninstall`, which start the **real**
//!   launcher: encoded script, `Start-Process -Verb RunAs`, the elevated script, the result file.
//!   On such an account `RunAs` completes without a prompt. **What this does not cover:** a UAC
//!   prompt answered (or dismissed) by a human, on the secure desktop. That is checked by hand.
//! - The upstream default `@anthropic-ai/sandbox-runtime@0.0.81` installed first under
//!   `apps/desktop/sandbox-sidecar/dist/upstream-srt` with its own vendored `srt-win.exe install`
//!   (account `srt-sandbox`, ports 60080-60089). The coexistence tests read its `status` and
//!   require it to be the same after anything ours does.
//! - `127.0.0.1 sw-loop.test` and `10.0.0.1 sw-private.test` in
//!   `%SystemRoot%\System32\drivers\etc\hosts` (hostname tests).
//! - `HTTP_PROXY`/`HTTPS_PROXY` (any case) pointing at a dead port in this process's environment.
//!   `poisoned_proxy_variables_never_reach_the_sandbox` fails when they are not, because the
//!   suite then proves nothing about them.
//!
//! # Shells
//!
//! The host runs Git Bash when `bin\bash.exe` exists in one of Git for Windows' fixed locations and
//! Windows PowerShell 5.1 otherwise, and there is no setting to choose (by design). Tests named
//! `shells_*` are written for both: the job runs the whole suite once with Git Bash, then
//! renames `Git\bin\bash.exe` and runs only `shells_*` again, which selects PowerShell. They talk
//! to the sandbox through Node scripts the test writes into the workspace (`sw-*.cjs`), so the
//! command text is the same in both shells apart from quoting. Node output is ASCII-escaped
//! JSON: Windows PowerShell 5.1 re-encodes native output through the OEM code page and would
//! mangle anything else.
//!
//! # Where Node lives (expectation; the job prints the facts)
//!
//! `actions/setup-node` installs under `C:\hostedtoolcache\windows\node\<version>\<arch>`,
//! outside the profile, so it is not a read root; it works because `Users` can read that tree
//! (the sandbox account is a member of `Users`). Were a runner to put Node inside the profile,
//! it would have to be a `PATH` entry so that the host grants it as a read root
//! (`srt_exec::read_roots_windows`). `node_runs_inside_the_sandbox` names both possibilities when
//! it fails.
//!
//! # Skips
//!
//! A test that cannot run because an optional tool is missing prints a line containing
//! `SKIPPED` and returns. The job fails when such a line appears on a runner where the tool is
//! present, so a skip can never swallow a real run.
mod support;

use base64::Engine;
use serde_json::{json, Value};
use sourceweft_desktop::local_host::{
    device_status::command_shell,
    execution::Executions,
    readiness::{bundle_dir, Remedy, SandboxReadiness, SetupCode},
    HostError, LocalHost, Workspace,
};
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, Once, OnceLock,
    },
    time::{Duration, Instant},
};
use support::{canonical, wire};

// ---------------------------------------------------------------------------------------------
// The scripts the sandboxed commands run (written into each workspace).
// ---------------------------------------------------------------------------------------------

/// Prints the environment the command sees, and proves the workspace is writable.
const ENV_SCRIPT: &str = r##"const fs = require('fs'), os = require('os'), path = require('path');
const ascii = o => JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
fs.writeFileSync('out.txt', 'hello');
fs.writeFileSync('a [b] \u6d4b\u8bd5 it\'s.txt', 'ok');
let tmpWrite;
try { const f = path.join(os.tmpdir(), 'sw-tmp-' + process.pid + '.txt'); fs.writeFileSync(f, 'x'); fs.unlinkSync(f); tmpWrite = 'ok'; } catch (e) { tmpWrite = 'ERR:' + e.code; }
let account;
try { account = os.userInfo().username; } catch (e) { account = 'ERR:' + e.code; }
const e = process.env;
console.log('ENV ' + ascii({ cwd: process.cwd(), home: e.HOME, temp: e.TEMP, tmp: e.TMP, tmpdir: os.tmpdir(), npmCache: e.npm_config_cache, pipCache: e.PIP_CACHE_DIR, nodeUseEnvProxy: e.NODE_USE_ENV_PROXY, httpsProxy: e.HTTPS_PROXY, httpProxy: e.HTTP_PROXY, allProxy: e.ALL_PROXY, account, tmpWrite }));
"##;

/// `node sw-read.cjs <path>`: leaves `.sw-control` (proof that it ran in the workspace), then
/// reads the path and says what happened.
const READ_SCRIPT: &str = r##"const fs = require('fs');
try { fs.writeFileSync('.sw-control', 'ran'); } catch (e) { console.log('CONTROL-ERR:' + e.code); }
try { console.log('READ-OK:' + fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { console.log('READ-ERR:' + e.code); }
"##;

/// `node sw-write.cjs <path>`: the same for writing.
const WRITE_SCRIPT: &str = r##"const fs = require('fs');
try { fs.writeFileSync('.sw-control', 'ran'); } catch (e) { console.log('CONTROL-ERR:' + e.code); }
try { fs.writeFileSync(process.argv[2], 'sw-escaped'); console.log('WRITE-OK'); } catch (e) { console.log('WRITE-ERR:' + e.code); }
"##;

/// `node sw-hold.cjs <name> <seconds>`: records when it started and finished (epoch ms).
const HOLD_SCRIPT: &str = r##"const fs = require('fs');
const [name, seconds] = process.argv.slice(2);
fs.writeFileSync(name + '.started', String(Date.now()));
setTimeout(() => { fs.writeFileSync(name + '.finished', String(Date.now())); }, Number(seconds) * 1000);
"##;

/// `node sw-tree.cjs <ping count> <marker>`: a process tree for the kill tests. A detached
/// `cmd.exe` running `ping` (cmd and ping both carry the unique count in their command lines), and
/// a second `node` whose command line carries the marker. Writes their pids to `tree.json`.
const TREE_SCRIPT: &str = r##"const { spawn } = require('child_process');
const fs = require('fs');
const [pingCount, marker] = process.argv.slice(2);
const cmd = spawn('cmd.exe', ['/d', '/c', 'ping', '-n', pingCount, '127.0.0.1'], { stdio: 'ignore', detached: true, windowsHide: true });
cmd.unref();
const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 600000) // ' + marker], { stdio: 'ignore', windowsHide: true });
fs.writeFileSync('tree.tmp', JSON.stringify({ self: process.pid, cmd: cmd.pid, node: child.pid }));
fs.renameSync('tree.tmp', 'tree.json');
setTimeout(function () {}, 600000);
"##;

const EXIT_SCRIPT: &str = "process.exit(Number(process.argv[2]));\n";

const BIG_SCRIPT: &str = "process.stdout.write('x'.repeat(Number(process.argv[2])) + '\\n');\n";

/// `node sw-net.cjs GET <https url>`: one HTTPS request through the sandbox proxy (CONNECT, then
/// TLS). Prints `PROBE {json}`. `agent: false` on the CONNECT: srt sets `NODE_USE_ENV_PROXY=1`,
/// which would otherwise make Node's global agent proxy this request a second time. (The same
/// probe the fork's own Windows CI runs.)
const NET_SCRIPT: &str = r##"const http = require('http'), tls = require('tls');
const [method, rawUrl] = process.argv.slice(2);
const out = o => console.log('PROBE ' + JSON.stringify(o));
setTimeout(() => { out({ stage: 'timeout' }); process.exit(5); }, 40000).unref();
const url = new URL(rawUrl);
const proxyRaw = process.env.https_proxy || process.env.HTTPS_PROXY;
if (!proxyRaw) { out({ stage: 'error', code: 'NO_PROXY_ENV' }); process.exit(4); }
const proxy = new URL(proxyRaw);
const pauth = proxy.username ? 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : undefined;
const port = url.port || 443;
const req = http.request({ agent: false, host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: url.hostname + ':' + port,
  headers: { host: url.hostname + ':' + port, ...(pauth && { 'proxy-authorization': pauth }) } });
req.on('connect', (res, socket) => {
  if (res.statusCode !== 200) { out({ stage: 'connect', status: res.statusCode, statusMessage: res.statusMessage }); process.exit(2); }
  const t = tls.connect({ socket, servername: url.hostname });
  t.on('error', e => { out({ stage: 'tls', code: e.code, message: String(e.message).slice(0, 300) }); process.exit(4); });
  const r2 = http.request({ createConnection: () => t, method, path: url.pathname + url.search, headers: { host: url.host, 'user-agent': 'sw-probe' } });
  r2.on('response', res2 => {
    let data = '';
    res2.on('data', d => { if (data.length < 2000) data += d; });
    res2.on('end', () => { out({ stage: 'response', status: res2.statusCode, bodyHead: data.slice(0, 200) }); process.exit(0); });
  });
  r2.on('error', e => { out({ stage: 'request', code: e.code, message: String(e.message).slice(0, 300) }); process.exit(4); });
  r2.end();
});
req.on('response', res => { out({ stage: 'response-to-connect', status: res.statusCode }); process.exit(3); });
req.on('error', e => { out({ stage: 'proxy', code: e.code, message: String(e.message).slice(0, 300) }); process.exit(4); });
req.end();
"##;

/// `node sw-connect.cjs <host:port>`: a hand-written `CONNECT` to the sandbox proxy, so the proxy
/// sees exactly the spelling under test (a client library would normalise it first, and
/// `NO_PROXY` would route private literals around the proxy). Prints `CONNECT {json}` with the
/// status, headers and whatever body or tunnel data followed.
const CONNECT_SCRIPT: &str = r##"const http = require('http');
const ascii = o => JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
const target = process.argv[2];
const proxy = new URL(process.env.HTTPS_PROXY || process.env.https_proxy);
const auth = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
const finish = o => process.stdout.write('CONNECT ' + ascii(o) + '\n', () => process.exit(0));
setTimeout(() => finish({ stage: 'timeout' }), 25000).unref();
const req = http.request({ agent: false, host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: target, headers: { host: target, 'proxy-authorization': auth } });
req.on('connect', (res, socket, head) => {
  let body = head.toString('latin1');
  const done = () => finish({ stage: 'connect', status: res.statusCode, headers: res.headers, body: body.slice(0, 1000) });
  if (res.statusCode === 200) socket.write('GET / HTTP/1.0\r\n\r\n');
  socket.setTimeout(3000, () => { socket.destroy(); done(); });
  socket.on('data', d => { body += d.toString('latin1'); });
  socket.on('close', done);
  socket.on('error', done);
});
req.on('response', res => {
  let body = '';
  res.on('data', d => { body += d; });
  res.on('end', () => finish({ stage: 'response', status: res.statusCode, headers: res.headers, body: body.slice(0, 1000) }));
});
req.on('error', e => finish({ stage: 'error', code: e.code, message: e.message }));
req.end();
"##;

/// `node sw-socks.cjs <host> <port>`: a SOCKS5 CONNECT with a DOMAINNAME destination to the
/// sandbox proxy (srt's mux serves SOCKS and HTTP on one port; `FTP_PROXY` names it when set).
/// Prints `greeting=0502`, `auth=0100`, `reply=05xx`, then whatever the tunnel returned.
const SOCKS_SCRIPT: &str = r##"const net = require('net');
const ascii = o => JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
const [dest, portArg] = process.argv.slice(2);
const raw = process.env.FTP_PROXY || process.env.ftp_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
const u = new URL(raw);
const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
const lines = ['proxy-from=' + (process.env.FTP_PROXY || process.env.ftp_proxy ? 'FTP_PROXY' : 'HTTPS_PROXY')];
const say = (k, v) => lines.push(k + '=' + v);
const finish = () => process.stdout.write(lines.join('\n') + '\n', () => process.exit(0));
const sock = net.connect({ host: u.hostname, port: Number(u.port) });
let stage = 0, buf = Buffer.alloc(0);
sock.setTimeout(20000, () => { say('timeout', stage); finish(); });
sock.on('error', e => { say('error', e.code); finish(); });
sock.on('connect', () => sock.write(Buffer.from([5, 1, 2])));
sock.on('data', d => {
  buf = Buffer.concat([buf, d]);
  if (stage === 0 && buf.length >= 2) {
    say('greeting', buf.subarray(0, 2).toString('hex')); buf = buf.subarray(2); stage = 1;
    sock.write(Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([pass.length]), Buffer.from(pass)]));
  }
  if (stage === 1 && buf.length >= 2) {
    say('auth', buf.subarray(0, 2).toString('hex')); buf = buf.subarray(2); stage = 2;
    const h = Buffer.from(dest), p = Number(portArg);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([p >> 8, p & 255])]));
  }
  if (stage === 2 && buf.length >= 2) {
    const reply = buf.subarray(0, 2).toString('hex');
    say('reply', reply);
    if (reply !== '0500') { finish(); return; }
    stage = 3; buf = buf.subarray(10);
    sock.write('GET / HTTP/1.0\r\n\r\n');
    setTimeout(() => { say('tunnel', ascii(buf.toString('latin1'))); finish(); }, 3000);
  }
});
"##;

/// `node sw-list.cjs <dir>...`: for each directory, whether `lstat` works and whether the
/// directory can be listed. Prints one `LIST {json}` line per directory.
const LIST_SCRIPT: &str = r##"const fs = require('fs');
try { fs.writeFileSync('.sw-control', 'ran'); } catch (e) { console.log('CONTROL-ERR:' + e.code); }
for (const dir of process.argv.slice(2)) {
  const r = { dir };
  try { r.lstat = fs.lstatSync(dir).isDirectory() ? 'dir' : 'other'; } catch (e) { r.lstat = 'ERR:' + e.code; }
  try { r.readdir = 'LISTED:' + fs.readdirSync(dir).length; } catch (e) { r.readdir = 'ERR:' + e.code; }
  console.log('LIST ' + JSON.stringify(r));
}
"##;

const SCRIPTS: [(&str, &str); 11] = [
    ("sw-env.cjs", ENV_SCRIPT),
    ("sw-read.cjs", READ_SCRIPT),
    ("sw-write.cjs", WRITE_SCRIPT),
    ("sw-hold.cjs", HOLD_SCRIPT),
    ("sw-tree.cjs", TREE_SCRIPT),
    ("sw-exit.cjs", EXIT_SCRIPT),
    ("sw-big.cjs", BIG_SCRIPT),
    ("sw-net.cjs", NET_SCRIPT),
    ("sw-connect.cjs", CONNECT_SCRIPT),
    ("sw-socks.cjs", SOCKS_SCRIPT),
    ("sw-list.cjs", LIST_SCRIPT),
];

// ---------------------------------------------------------------------------------------------
// Machine facts and helpers on the test (host) side.
// ---------------------------------------------------------------------------------------------

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var(name).unwrap_or_else(|_| panic!("%{name}% must be set for this test")),
    )
}

fn system_root() -> PathBuf {
    env_path("SystemRoot")
}

fn profile_dir() -> PathBuf {
    canonical(&env_path("USERPROFILE"))
}

fn program_files() -> PathBuf {
    std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from)
        .expect("%ProgramW6432% or %ProgramFiles% must be set")
}

/// Where the setup stages `srt-win.exe` (`windows::staged_srt_win_path`).
fn staged_srt_win() -> PathBuf {
    program_files()
        .join("SourceWeft")
        .join("sandbox")
        .join("srt-win.exe")
}

/// `apps/desktop/sandbox-sidecar/dist/bundle`, built by that package's `build` script.
fn built_bundle_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sandbox-sidecar/dist/bundle")
}

/// The upstream default `srt-win.exe` the job installs first (see the module doc).
fn upstream_srt_win() -> PathBuf {
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../sandbox-sidecar/dist/upstream-srt/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win")
        .join(arch)
        .join("srt-win.exe");
    assert!(
        path.is_file(),
        "expected the upstream default srt at {path:?}: install @anthropic-ai/sandbox-runtime@0.0.81 \
         under apps/desktop/sandbox-sidecar/dist/upstream-srt and run its vendored \
         `srt-win.exe install` first (scripts/ci/windows-sandbox-coexist.ps1 install-upstream; the \
         windows-sandbox CI job does this before the suite)"
    );
    path
}

/// The built bundle, copied once per test process into a private folder, with its sidecar run
/// once. Every test then gets its own `<app data>/sandbox/current` from it ([`copy_bundle_into`]).
///
/// Why not copy the built bundle for every test: the executables are big, and on a Windows ARM
/// runner copying and first-running a fresh copy of each one cost about half a minute per test
/// (the whole suite took twenty minutes against three and a half on x64, and the first two tests
/// ran into the host's 30 second limit on preparing a folder). The timing lines (`TIMING:`) in the
/// log show where the time goes.
fn cached_bundle() -> &'static Path {
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    CACHE.get_or_init(|| {
        let _w = watch("preparing the bundle copy", Duration::from_secs(600));
        let source = built_bundle_source();
        assert!(
            source.join("srt-sidecar.exe").is_file() && source.join("srt-win.exe").is_file(),
            "expected a built Windows sandbox bundle (srt-sidecar.exe, srt-win.exe, manifest.json) at \
             {source:?}; run `pnpm --filter @sourceweft/desktop-sandbox-sidecar build -- --target \
             <triple> --rg <path to rg.exe>` first"
        );
        let dir = std::env::temp_dir().join(format!("sw-sandbox-bundle-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let started = Instant::now();
        for entry in fs::read_dir(&source).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
        }
        eprintln!("TIMING: copied the bundle once in {:?}", started.elapsed());
        // The first run of a new executable can be slow (virus scanning); take it here, once and
        // visibly, instead of inside the first test's 30 second limit on starting a sandbox.
        let started = Instant::now();
        let mut sidecar = Command::new(dir.join("srt-sidecar.exe"));
        sidecar.arg("--print-namespace");
        match run_bounded_result(sidecar, Duration::from_secs(300)) {
            Ok(output) => eprintln!(
                "TIMING: first run of srt-sidecar.exe took {:?} (exit {}, printed {:?})",
                started.elapsed(),
                output.status,
                String::from_utf8_lossy(&output.stdout).trim()
            ),
            Err(error) => panic!("the sidecar of the built bundle cannot run: {error}"),
        }
        dir
    })
}

/// Gives `dest` (`<app data>/sandbox/current`) the built bundle: the two big executables as hard
/// links to the process-wide copy (same volume permitting; a copy otherwise), everything else as
/// real copies, so a test that edits `manifest.json` or `srt-win.exe` edits its own file.
fn copy_bundle_into(dest: &Path) {
    let cache = cached_bundle();
    fs::create_dir_all(dest).unwrap();
    for entry in fs::read_dir(cache).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let target = dest.join(&name);
        let shared = name == "srt-sidecar.exe" || name == "rg.exe";
        if shared && fs::hard_link(entry.path(), &target).is_ok() {
            continue;
        }
        fs::copy(entry.path(), &target).unwrap();
    }
}

// ---------------------------------------------------------------------------------------------
// Nothing in this file may wait forever. A stuck command, setup or helper process ends the whole
// test binary with a message that names what was stuck and a snapshot of the related processes,
// so the job fails with its logs instead of running into the job timeout (and the cleanup steps
// still run).
// ---------------------------------------------------------------------------------------------

/// Live deadlines: `(id, what, expires)`. Slot 0 is the current test's overall budget.
static DEADLINES: Mutex<Vec<(u64, String, Instant)>> = Mutex::new(Vec::new());
static DEADLINE_IDS: AtomicU64 = AtomicU64::new(1);

/// How long one test may take in total, from the moment it opens its host. The whole suite takes
/// minutes on a fast runner; this is for a hang, not for a slow machine.
const TEST_BUDGET: Duration = Duration::from_secs(12 * 60);

fn start_watchdog() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(1));
            let expired = {
                let slots = DEADLINES.lock().unwrap_or_else(|e| e.into_inner());
                slots
                    .iter()
                    .find(|(_, _, at)| Instant::now() > *at)
                    .map(|(_, what, _)| what.clone())
            };
            if let Some(what) = expired {
                hung(&what);
            }
        });
    });
}

/// Reports what hung, with the processes that matter, and ends the test binary (exit code 124).
fn hung(what: &str) -> ! {
    eprintln!("\nHUNG: {what}\nThe test binary is being stopped because this did not finish in time.");
    let script = "\
        Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'srt|powershell|pwsh|node|cmd|ping|git|curl|bash|bun|conhost|windows_sandbox' } | \
        ForEach-Object { $c = [string]$_.CommandLine; if ($c.Length -gt 260) { $c = $c.Substring(0, 260) }; '{0} ppid={1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $c }\n\
        $r = Join-Path $(if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }) 'SourceWeft\\sandbox-setup-result.json'\n\
        if (Test-Path -LiteralPath $r) { 'setup result: ' + (Get-Content -Raw -LiteralPath $r) }\n";
    let mut command = Command::new(windows_powershell());
    command
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
        .arg(encoded(script));
    match run_bounded_result(command, Duration::from_secs(60)) {
        Ok(output) => eprintln!(
            "processes at the time:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(error) => eprintln!("(the process snapshot failed: {error})"),
    }
    std::process::exit(124);
}

/// Removes its deadline when dropped.
struct Watch(u64);
impl Drop for Watch {
    fn drop(&mut self) {
        let mut slots = DEADLINES.lock().unwrap_or_else(|e| e.into_inner());
        slots.retain(|(id, _, _)| *id != self.0);
    }
}

/// `what` must be over within `limit`, or the binary is stopped (see [`hung`]). Held while the
/// guarded step runs.
fn watch(what: impl Into<String>, limit: Duration) -> Watch {
    start_watchdog();
    let id = DEADLINE_IDS.fetch_add(1, Ordering::SeqCst);
    DEADLINES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((id, what.into(), Instant::now() + limit));
    Watch(id)
}

/// Starts the overall budget of the test that is beginning (replacing the previous test's).
fn arm_test() {
    start_watchdog();
    let name = std::thread::current().name().unwrap_or("a test").to_string();
    {
        static LAST: Mutex<Option<Instant>> = Mutex::new(None);
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = *last {
            eprintln!("TIMING: the previous test took {:?} from opening its host to the next one", previous.elapsed());
        }
        *last = Some(Instant::now());
    }
    let mut slots = DEADLINES.lock().unwrap_or_else(|e| e.into_inner());
    slots.retain(|(id, _, _)| *id != 0);
    slots.push((
        0,
        format!("{name} did not finish within its {} minute budget", TEST_BUDGET.as_secs() / 60),
        Instant::now() + TEST_BUDGET,
    ));
}

/// Runs `command` (stdin closed, both streams captured) and kills it when it has not finished
/// within `limit`. Output the process leaves in pipes that a grandchild still holds open is
/// abandoned after a short grace period instead of waited for.
fn run_bounded_result(mut command: Command, limit: Duration) -> Result<std::process::Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("cannot start it: {error}"))?;
    let (sender, receiver) = mpsc::channel::<(bool, Vec<u8>)>();
    for (is_stdout, stream) in [
        (true, child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)),
        (false, child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)),
    ] {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut bytes);
            }
            let _ = sender.send((is_stdout, bytes));
        });
    }
    drop(sender);
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("did not finish within {limit:?} and was killed"));
            }
            Err(error) => return Err(format!("cannot wait for it: {error}")),
        }
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    for _ in 0..2 {
        if let Ok((is_stdout, bytes)) = receiver.recv_timeout(Duration::from_secs(10)) {
            if is_stdout {
                stdout = bytes;
            } else {
                stderr = bytes;
            }
        }
    }
    Ok(std::process::Output { status, stdout, stderr })
}

/// [`run_bounded_result`], panicking with `what` when it fails.
fn run_bounded(command: Command, limit: Duration, what: &str) -> std::process::Output {
    run_bounded_result(command, limit).unwrap_or_else(|error| panic!("{what}: {error}"))
}

/// Host-side helper processes (status, PowerShell queries, curl controls) are quick; a minute and
/// a half is a hang.
const HELPER_LIMIT: Duration = Duration::from_secs(90);

/// `text` as the UTF-16LE base64 that `powershell -EncodedCommand` takes.
fn encoded(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn windows_powershell() -> PathBuf {
    system_root().join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

/// Runs `script` in a fresh Windows PowerShell on the host (not sandboxed). Returns
/// `(succeeded, stdout + stderr)`.
fn host_powershell(script: &str) -> (bool, String) {
    let mut command = Command::new(windows_powershell());
    command
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
        .arg(encoded(script));
    let output = run_bounded(command, HELPER_LIMIT, "Windows PowerShell on the host");
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.success(), text)
}

/// The `srt-win status` JSON of the helper at `exe` (not elevated-only: the runner is an
/// administrator, so the WFP filters are readable).
fn srt_win_status(exe: &Path) -> Value {
    let mut command = Command::new(exe);
    command.arg("status");
    let output = run_bounded(command, HELPER_LIMIT, &format!("`{exe:?} status`"));
    assert!(
        output.status.success(),
        "`{exe:?} status` failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "`{exe:?} status` did not print JSON ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

/// Which `node.exe` the sandbox will resolve, for failure messages.
fn describe_node() -> String {
    let path = std::env::var("PATH").unwrap_or_default();
    let found = path
        .split(';')
        .filter(|entry| !entry.is_empty())
        .map(|entry| Path::new(entry).join("node.exe"))
        .find(|candidate| candidate.is_file());
    match found {
        Some(node) => {
            let inside = node.starts_with(profile_dir());
            format!(
                "node.exe on PATH: {node:?} (inside the user profile: {inside}). The sandbox account \
                 must be able to read its folder; a folder inside the profile is readable only when \
                 it is a PATH entry (it becomes a read root)."
            )
        }
        None => "node.exe is not on PATH, so the sandbox cannot find it either".to_string(),
    }
}

/// `sandbox_readiness()` once the setup has just run: the first start of the sandbox after a fresh
/// install is slow (the sandbox account's profile is created at its first logon; arm64 runners
/// are slower still), and the host reports that as the transient `installing` ("still getting
/// ready") answer. Polls while the answer is transient, up to `limit`, and returns the settled
/// one (or the last transient one when the time is up, which the caller's assertion then shows).
fn settled_readiness(host: &LocalHost, limit: Duration) -> SandboxReadiness {
    let deadline = Instant::now() + limit;
    loop {
        let readiness = host.sandbox_readiness();
        let transient = readiness.is_checking()
            || matches!(&readiness, SandboxReadiness::NeedsSetup { code: SetupCode::Installing, .. });
        if !transient || Instant::now() >= deadline {
            return readiness;
        }
        eprintln!("readiness is still transient, checking again in 5 s: {readiness:?}");
        std::thread::sleep(Duration::from_secs(5));
        host.invalidate_sandbox_readiness();
    }
}

/// How long a test waits for the sandbox to become ready after the setup.
const READY_AFTER_SETUP: Duration = Duration::from_secs(300);

/// Process-wide record that the sandbox is installed, so only the first test pays for the setup.
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Makes sure the sandbox is installed on this machine: through the real elevated launcher, once
/// per test process, unless it is already ready (a developer machine that has it).
fn ensure_installed(host: &LocalHost) {
    if INSTALLED.load(Ordering::SeqCst) {
        return;
    }
    let ready = {
        let _w = watch("the first readiness check", Duration::from_secs(300));
        matches!(host.sandbox_readiness(), SandboxReadiness::Ready { .. })
    };
    if !ready {
        let _w = watch("the elevated sandbox setup (through the real launcher)", Duration::from_secs(600));
        host.run_elevated_setup().unwrap_or_else(|error| {
            panic!(
                "the elevated sandbox setup failed: {error}. See %ProgramFiles%\\SourceWeft\\sandbox-setup-result.json \
                 for the script's own account of it. (On the CI runner this means Start-Process -Verb RunAs did not \
                 work without a prompt, or srt-win could not install.)"
            )
        });
    }
    let readiness = {
        let _w = watch("the readiness check after the setup", Duration::from_secs(660));
        settled_readiness(host, READY_AFTER_SETUP)
    };
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "the sandbox must be ready after the setup, got {readiness:?}"
    );
    INSTALLED.store(true, Ordering::SeqCst);
}

/// A `LocalHost` over a fresh temporary app-data directory with the built bundle installed at
/// `<app data>/sandbox/current`, and the sandbox set up on this machine.
fn host_with_bundle() -> (tempfile::TempDir, LocalHost) {
    let (app, host) = host_without_setup();
    ensure_installed(&host);
    (app, host)
}

/// The same, without touching the machine-wide setup.
fn host_without_setup() -> (tempfile::TempDir, LocalHost) {
    arm_test();
    let app = tempfile::tempdir().unwrap();
    let started = Instant::now();
    copy_bundle_into(&bundle_dir(app.path()));
    let copied = started.elapsed();
    let host = LocalHost::open(app.path()).unwrap();
    host.initialize_invocation_journal().unwrap();
    eprintln!("TIMING: test bundle {copied:?}, host open {:?}", started.elapsed() - copied);
    (app, host)
}

fn write_scripts(root: &Path) {
    for (name, body) in SCRIPTS {
        fs::write(root.join(name), body).unwrap();
    }
}

/// An automatic workspace with the scripts written before its sandbox starts (so they exist when
/// the workspace grant is stamped).
fn new_workspace(host: &LocalHost, thread: &str) -> Workspace {
    let workspace = host.ensure_workspace("owner", thread).unwrap();
    write_scripts(&workspace.path);
    workspace
}

/// A workspace on the granted folder `dir`, scripts included. Returns the workspace and the
/// canonical root the host recorded.
fn granted_workspace(host: &LocalHost, thread: &str, dir: &Path) -> (Workspace, PathBuf) {
    let (grant, root) = host.grant_directory("owner", dir).unwrap();
    write_scripts(&root);
    let workspace = host
        .ensure_workspace_with_grant("owner", thread, Some(&grant))
        .unwrap();
    (workspace, root)
}

static CALLS: AtomicU64 = AtomicU64::new(0);

fn call_id(label: &str) -> String {
    format!("{label}-{}", CALLS.fetch_add(1, Ordering::SeqCst))
}

fn try_execute(
    host: &LocalHost,
    executions: &Executions,
    label: &str,
    workspace: &Workspace,
    command: &str,
    timeout_ms: u64,
    max_chars: u64,
) -> Result<Value, HostError> {
    // The command's own timeout, plus what starting a sidecar and stamping the folder may take.
    let _w = watch(
        format!("command.execute `{label}` ({command})"),
        Duration::from_millis(timeout_ms) + Duration::from_secs(150),
    );
    let started = Instant::now();
    let result = host.dispatch(
        executions,
        &call_id(label),
        "owner",
        &workspace.thread_id,
        "command.execute",
        json!({"workspaceId": workspace.id, "command": command, "timeoutMs": timeout_ms, "maxOutputChars": max_chars}),
    );
    if started.elapsed() > Duration::from_secs(5) {
        eprintln!("TIMING: command.execute `{label}` took {:?}", started.elapsed());
    }
    result
}

fn execute(host: &LocalHost, label: &str, workspace: &Workspace, command: &str) -> Value {
    try_execute(
        host,
        &Executions::default(),
        label,
        workspace,
        command,
        110_000,
        20_000,
    )
    .unwrap_or_else(|error| {
        panic!(
            "command.execute failed: {error}\ncommand: {command}\n{}",
            describe_node()
        )
    })
}

fn output(result: &Value) -> &str {
    result["output"].as_str().unwrap()
}

/// Removes a planted file or directory even when an assertion fails.
struct RemoveOnDrop(PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Sets an environment variable of this test process for a while.
struct EnvGuard {
    name: &'static str,
    previous: Option<OsString>,
}
impl EnvGuard {
    fn set(name: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(self.name, value),
            None => std::env::remove_var(self.name),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The shell the host chose, and command text for it.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shell {
    GitBash,
    PowerShell,
}

fn active_shell() -> Shell {
    match command_shell() {
        Some("bash") => Shell::GitBash,
        Some("powershell") => Shell::PowerShell,
        other => panic!(
            "the host reports no usable command shell ({other:?}); Git for Windows or Windows \
             PowerShell 5.1 must be installed"
        ),
    }
}

/// A single-quoted literal in which nothing is interpreted, for `shell`.
fn quote(shell: Shell, text: &str) -> String {
    match shell {
        Shell::GitBash => format!("'{}'", text.replace('\'', "'\\''")),
        Shell::PowerShell => {
            // Windows PowerShell treats the four typographic quotes like the ASCII one.
            let mut quoted = String::from("'");
            for c in text.chars() {
                quoted.push(c);
                if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
                    quoted.push(c);
                }
            }
            quoted.push('\'');
            quoted
        }
    }
}

/// `node <script> <quoted args...>`; scripts live in the workspace root, which is the cwd.
fn node(shell: Shell, script: &str, args: &[&str]) -> String {
    let mut command = format!("node {script}");
    for arg in args {
        command.push(' ');
        command.push_str(&quote(shell, arg));
    }
    command
}

/// `path` with forward slashes, which both shells and Windows accept.
fn forward(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// An absolute executable invoked with raw `args` text: `'exe' args` in Git Bash, `& 'exe' args`
/// in PowerShell (which needs the call operator in front of a quoted name).
fn call(shell: Shell, exe: &Path, args: &str) -> String {
    let exe = quote(shell, &forward(exe));
    match shell {
        Shell::GitBash => format!("{exe} {args}"),
        Shell::PowerShell => format!("& {exe} {args}"),
    }
}

/// A PowerShell script run inside the sandbox (as an encoded command, so no shell quoting).
fn sandboxed_powershell(shell: Shell, script: &str) -> String {
    call(
        shell,
        &windows_powershell(),
        &format!("-NoProfile -NonInteractive -EncodedCommand {}", encoded(script)),
    )
}

/// Compares paths the way the tests need: separators and case do not matter (Git Bash may rewrite
/// separators in the variables it passes on).
fn norm(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn line_with<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.lines().find_map(|line| line.strip_prefix(prefix))
}

/// The `ENV {json}` line of `sw-env.cjs`.
fn env_probe(host: &LocalHost, label: &str, workspace: &Workspace, shell: Shell) -> (Value, Value) {
    let result = execute(host, label, workspace, &node(shell, "sw-env.cjs", &[]));
    let line = line_with(output(&result), "ENV ").unwrap_or_else(|| {
        panic!(
            "sw-env.cjs printed no ENV line, so Node did not run in the sandbox ({shell:?}): {result}\n{}",
            describe_node()
        )
    });
    let env = serde_json::from_str(line)
        .unwrap_or_else(|error| panic!("the ENV line is not JSON ({error}): {line}"));
    (result, env)
}

/// Runs `sw-read.cjs <target>` and checks the positive control (`.sw-control`) so that a denial
/// cannot be a command that never ran.
fn read_probe(host: &LocalHost, label: &str, workspace: &Workspace, shell: Shell, target: &Path) -> Value {
    let control = workspace.path.join(".sw-control");
    let _ = fs::remove_file(&control);
    let target_text = target.to_string_lossy().into_owned();
    let result = execute(
        host,
        label,
        workspace,
        &node(shell, "sw-read.cjs", &[target_text.as_str()]),
    );
    assert_eq!(
        fs::read_to_string(&control).ok().as_deref(),
        Some("ran"),
        "the sandboxed Node never ran in the workspace, so a denial would prove nothing ({shell:?}): {result}\n{}",
        describe_node()
    );
    result
}

fn write_probe(host: &LocalHost, label: &str, workspace: &Workspace, shell: Shell, target: &Path) -> Value {
    let control = workspace.path.join(".sw-control");
    let _ = fs::remove_file(&control);
    let target_text = target.to_string_lossy().into_owned();
    let result = execute(
        host,
        label,
        workspace,
        &node(shell, "sw-write.cjs", &[target_text.as_str()]),
    );
    assert_eq!(
        fs::read_to_string(&control).ok().as_deref(),
        Some("ran"),
        "the sandboxed Node never ran in the workspace, so a denial would prove nothing ({shell:?}): {result}\n{}",
        describe_node()
    );
    result
}

/// The read was refused by the file system (the sandbox account has no access), and the planted
/// content never reached the output.
fn assert_read_denied(result: &Value, secret: &str, what: &str) {
    let text = output(result);
    assert!(
        !text.contains(secret),
        "the sandbox read {what}: its content is in the output: {result}"
    );
    let line = text.lines().find(|l| l.starts_with("READ-")).unwrap_or("");
    assert!(
        line == "READ-ERR:EACCES" || line == "READ-ERR:EPERM",
        "reading {what} must be refused with EACCES or EPERM (the sandbox account has no access), \
         got {line:?}. ENOENT would mean the test planted the wrong path: {result}"
    );
}

fn assert_write_denied(result: &Value, target: &Path, what: &str) {
    let line = output(result)
        .lines()
        .find(|l| l.starts_with("WRITE-"))
        .unwrap_or("");
    assert!(
        line == "WRITE-ERR:EACCES" || line == "WRITE-ERR:EPERM",
        "writing {what} must be refused with EACCES or EPERM, got {line:?}: {result}"
    );
    assert!(
        !target.exists(),
        "{what} exists on the host after a refused write: {result}"
    );
}

/// `pid image command line` for every process on the host that is one of `pids` or whose command
/// line contains any of `needles`, except the query's own PowerShell.
fn live_matches(pids: &[u32], needles: &[&str]) -> Vec<String> {
    let pid_list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let needle_list = needles
        .iter()
        .map(|needle| format!("'{}'", needle.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $pids = @({pid_list})\n\
         $needles = @({needle_list})\n\
         Get-CimInstance Win32_Process | Where-Object {{\n\
         \x20 if ($_.ProcessId -eq $PID) {{ return $false }}\n\
         \x20 if ($pids -contains [int]$_.ProcessId) {{ return $true }}\n\
         \x20 $line = [string]$_.CommandLine\n\
         \x20 foreach ($n in $needles) {{ if ($line.Contains($n)) {{ return $true }} }}\n\
         \x20 return $false\n\
         }} | ForEach-Object {{ 'MATCH {{0}} {{1}}' -f $_.ProcessId, $_.Name }}\n"
    );
    let (ok, text) = host_powershell(&script);
    assert!(ok, "the process query failed: {text}");
    text.lines()
        .filter_map(|line| line.strip_prefix("MATCH "))
        .map(str::to_string)
        .collect()
}

/// Polls `check` every half second until it returns true or `limit` passes.
fn wait_until(limit: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        if check() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// A count for `ping -n` that is unique to this run: it is what the survivor query looks for in
/// command lines (both `cmd.exe` and `ping.exe` carry it).
fn unique_ping_count() -> String {
    let id = uuid::Uuid::new_v4().as_u128();
    format!("{}", 40_000 + (id % 9_000))
}

// ---------------------------------------------------------------------------------------------
// Setup and readiness (machine state: these run once, not in the PowerShell pass).
// ---------------------------------------------------------------------------------------------

/// Puts the sandbox back (best effort) if an assertion fails between an uninstall and the
/// reinstall, so one failure does not take every later test with it.
struct Reinstall<'a> {
    host: &'a LocalHost,
    armed: bool,
}
impl Drop for Reinstall<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.host.run_elevated_setup();
        }
    }
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn setup_through_the_real_launcher_makes_readiness_ready() {
    // The runner is an administrator with UAC consent disabled, so `Start-Process -Verb RunAs`
    // completes without a prompt: this runs the real launcher end to end (encoded script,
    // elevation, the elevated script, the result file). A UAC prompt answered by a human is NOT
    // covered by this test.
    let (_app, host) = host_without_setup();
    host.run_elevated_setup().unwrap_or_else(|error| {
        panic!(
            "the elevated setup failed: {error}. See %ProgramFiles%\\SourceWeft\\sandbox-setup-result.json for \
             the script's message and exit code (12 network rules, 13 conflicting install, 14 account, 21/41 hash, 40 not elevated)"
        )
    });
    let readiness = settled_readiness(&host, READY_AFTER_SETUP);
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "readiness must be Ready once the setup has run, got {readiness:?}"
    );
    INSTALLED.store(true, Ordering::SeqCst);

    // The staged helper is the bundle's, byte for byte.
    let staged = fs::read(staged_srt_win()).expect("the setup stages srt-win.exe under Program Files");
    let bundled = fs::read(bundle_dir(_app.path()).join("srt-win.exe")).unwrap();
    assert!(
        staged == bundled,
        "the staged srt-win.exe must be identical to the bundle's (the setup verifies the copy's SHA-256)"
    );

    // And it is the namespaced install: our account, our port range.
    let status = srt_win_status(&staged_srt_win());
    assert_eq!(status["user"]["user"]["name"], "sourceweft-sandbox", "{status}");
    assert_eq!(status["user"]["user"]["exists"], true, "{status}");
    assert_eq!(status["wfp"]["state"], "installed", "{status}");
    assert_eq!(status["wfp"]["port_range"], json!([60180, 60189]), "{status}");
    assert_eq!(status["wfp"]["allow_loopback"], false, "{status}");
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn setup_a_bundle_listing_another_helper_needs_setup_outdated() {
    let (app, host) = host_with_bundle();
    let manifest_path = bundle_dir(app.path()).join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["files"]["srt-win.exe"]["sha256"] = json!("0".repeat(64));
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    host.invalidate_sandbox_readiness();
    match host.sandbox_readiness() {
        SandboxReadiness::NeedsSetup { code, remedy, reason, .. } => {
            assert_eq!(
                code,
                SetupCode::WindowsSetupOutdated,
                "a staged helper that is not the bundle's must be reported as outdated: {reason}"
            );
            assert_eq!(remedy, Remedy::ElevatedSetup, "{reason}");
        }
        other => panic!(
            "a staged helper that differs from the bundle's must need setup (windowsSetupOutdated), got {other:?}"
        ),
    }
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn setup_refuses_a_bundle_helper_that_does_not_match_its_manifest() {
    // Refused before any elevation: no prompt, and the machine is untouched.
    let (app, host) = host_with_bundle();
    let before = fs::read(staged_srt_win()).unwrap();
    let helper = bundle_dir(app.path()).join("srt-win.exe");
    let mut file = fs::OpenOptions::new().append(true).open(&helper).unwrap();
    file.write_all(b"tampered").unwrap();
    drop(file);
    let error = host
        .run_elevated_setup()
        .expect_err("the setup must refuse a helper whose hash is not the manifest's");
    assert!(
        error.contains("does not match its manifest"),
        "the refusal must say the helper does not match its manifest, got: {error}"
    );
    assert!(
        fs::read(staged_srt_win()).unwrap() == before,
        "a refused setup must leave the staged helper alone"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn setup_a_tampered_staged_helper_is_outdated_and_the_setup_repairs_it() {
    let (_app, host) = host_with_bundle();
    let staged = staged_srt_win();
    let mut guard = Reinstall { host: &host, armed: true };
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&staged)
        .unwrap_or_else(|error| panic!("cannot open the staged helper {staged:?} for the tamper: {error}"));
    file.write_all(b"tampered").unwrap();
    drop(file);
    host.invalidate_sandbox_readiness();
    match host.sandbox_readiness() {
        SandboxReadiness::NeedsSetup { code, remedy, reason, .. } => {
            assert_eq!(
                code,
                SetupCode::WindowsSetupOutdated,
                "a staged helper whose hash is not the bundle's must never be run; readiness must say outdated: {reason}"
            );
            assert_eq!(remedy, Remedy::ElevatedSetup, "{reason}");
        }
        other => panic!("a tampered staged helper must need setup (windowsSetupOutdated), got {other:?}"),
    }
    host.run_elevated_setup()
        .unwrap_or_else(|error| panic!("the setup must replace a tampered staged helper: {error}"));
    guard.armed = false;
    let readiness = settled_readiness(&host, READY_AFTER_SETUP);
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "after the setup replaced the tampered helper readiness must be Ready, got {readiness:?}"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn setup_uninstall_returns_to_not_installed_and_leaves_the_upstream_install_alone() {
    // The upstream default install (account srt-sandbox, ports 60080-60089) is on the machine for
    // the whole run. Removing OURS through the real launcher must not change anything of its.
    let upstream = upstream_srt_win();
    let upstream_before = srt_win_status(&upstream);
    assert_eq!(
        upstream_before["user"]["user"]["name"], "srt-sandbox",
        "precondition: the upstream default install must be present: {upstream_before}"
    );
    let (_app, host) = host_with_bundle();
    let mut guard = Reinstall { host: &host, armed: true };
    host.run_elevated_uninstall()
        .unwrap_or_else(|error| panic!("the elevated uninstall failed: {error}"));
    host.invalidate_sandbox_readiness();
    match host.sandbox_readiness() {
        SandboxReadiness::NeedsSetup { code, remedy, reason, .. } => {
            assert_eq!(
                code,
                SetupCode::WindowsNotInstalled,
                "after the uninstall the sandbox must report windowsNotInstalled: {reason}"
            );
            assert_eq!(remedy, Remedy::ElevatedSetup, "{reason}");
        }
        other => panic!("after the uninstall readiness must need setup, got {other:?}"),
    }
    assert!(
        !staged_srt_win().exists(),
        "the uninstall must remove the staged helper {:?}",
        staged_srt_win()
    );
    let (ok, text) = host_powershell(
        "if (Get-LocalUser -Name 'sourceweft-sandbox' -ErrorAction SilentlyContinue) { 'ACCOUNT-PRESENT' } else { 'ACCOUNT-GONE' }",
    );
    assert!(
        ok && text.contains("ACCOUNT-GONE"),
        "the uninstall must remove the sourceweft-sandbox account: {text}"
    );
    let upstream_after = srt_win_status(&upstream);
    assert_eq!(
        upstream_before, upstream_after,
        "removing the SourceWeft sandbox changed the upstream default install's status"
    );
    assert_eq!(upstream_after["user"]["user"]["exists"], true, "{upstream_after}");

    // Put it back, again through the real launcher, and prove it works.
    host.run_elevated_setup()
        .unwrap_or_else(|error| panic!("the reinstall after the uninstall failed: {error}"));
    guard.armed = false;
    let readiness = settled_readiness(&host, READY_AFTER_SETUP);
    assert!(
        matches!(readiness, SandboxReadiness::Ready { .. }),
        "after the reinstall readiness must be Ready, got {readiness:?}"
    );
    assert_eq!(
        srt_win_status(&upstream),
        upstream_before,
        "reinstalling the SourceWeft sandbox changed the upstream default install's status"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn setup_uninstall_works_without_the_staged_helper_and_revokes_the_ancestor_grants() {
    // The staged helper is gone (deleted, or never fully staged) but the account and the network
    // rules exist: the uninstall must still remove them, through the pinned, hash-verified helper
    // of the installed runtime, and must not report success for a sandbox it left behind.
    let (app, host) = host_with_bundle();
    let mut guard = Reinstall { host: &host, armed: true };
    // A workspace under the profile makes the host grant ancestor traversal (and record it).
    let (_scratch, scratch) = profile_scratch("sw-anc-unin-");
    let nested = scratch.join("w");
    fs::create_dir_all(&nested).unwrap();
    let (workspace, _) = granted_workspace(&host, "unin", &nested);
    let (result, _) = env_probe(&host, "unin", &workspace, active_shell());
    assert_eq!(result["exitCode"], 0, "{result}");
    assert!(
        ancestor_record(app.path()).is_some(),
        "precondition: the host recorded the ancestor grants it added"
    );
    let with_grant = acl_report(&scratch);
    assert_eq!(with_grant.sandbox_entries().len(), 1, "{:?}", with_grant.aces);

    fs::remove_file(staged_srt_win()).expect("delete the staged helper");
    host.run_elevated_uninstall()
        .unwrap_or_else(|error| panic!("the uninstall without the staged helper failed: {error}"));
    let (ok, text) = host_powershell(
        "if (Get-LocalUser -Name 'sourceweft-sandbox' -ErrorAction SilentlyContinue) { 'ACCOUNT-PRESENT' } else { 'ACCOUNT-GONE' }",
    );
    assert!(
        ok && text.contains("ACCOUNT-GONE"),
        "the uninstall must remove the account even without the staged helper: {text}"
    );
    let staged_dir = staged_srt_win().parent().unwrap().to_path_buf();
    assert!(!staged_dir.exists(), "the uninstall must remove {staged_dir:?}");
    // Revoked by the uninstall: the entry is gone although its account no longer resolves.
    assert!(
        acl_report(&scratch).sandbox_entries().is_empty()
            && !acl_report(&scratch).aces.iter().any(|line| line.contains("S-1-5-21")
                && line.contains("|Allow|1179808|")),
        "the uninstall must take back the ancestor grants: {:?}",
        acl_report(&scratch).aces
    );
    assert!(ancestor_record(app.path()).is_none(), "the record is removed with the grants");

    host.run_elevated_setup()
        .unwrap_or_else(|error| panic!("the reinstall after the uninstall failed: {error}"));
    guard.armed = false;
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn upstream_default_install_coexists_with_ours() {
    let upstream = upstream_srt_win();
    let (_app, host) = host_with_bundle();
    let ours = srt_win_status(&staged_srt_win());
    let theirs_before = srt_win_status(&upstream);
    assert_eq!(ours["user"]["user"]["name"], "sourceweft-sandbox", "{ours}");
    assert_eq!(theirs_before["user"]["user"]["name"], "srt-sandbox", "{theirs_before}");
    assert_ne!(
        ours["user"]["user"]["sid"], theirs_before["user"]["user"]["sid"],
        "the two installs must have different accounts: {ours} / {theirs_before}"
    );
    assert!(
        ours["user"]["user"]["sid"].is_string() && theirs_before["user"]["user"]["sid"].is_string(),
        "both accounts must exist: {ours} / {theirs_before}"
    );
    assert_eq!(ours["wfp"]["port_range"], json!([60180, 60189]), "{ours}");
    assert_eq!(theirs_before["wfp"]["port_range"], json!([60080, 60089]), "{theirs_before}");
    assert_eq!(theirs_before["wfp"]["state"], "installed", "{theirs_before}");

    // Our sandbox works while the upstream one is installed, and does not disturb it.
    let shell = active_shell();
    let workspace = new_workspace(&host, "thread");
    let (_, env) = env_probe(&host, "coexist", &workspace, shell);
    assert!(
        env["account"].as_str().unwrap_or_default().to_lowercase().contains("sourceweft-sandbox"),
        "commands must run as the sourceweft-sandbox account, not srt-sandbox: {env}"
    );
    assert_eq!(
        srt_win_status(&upstream),
        theirs_before,
        "running a command in the SourceWeft sandbox changed the upstream install's status"
    );
}

// ---------------------------------------------------------------------------------------------
// Execution: environment, files, reads and writes.
// ---------------------------------------------------------------------------------------------

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn node_runs_inside_the_sandbox() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let result = execute(&host, "node-version", &workspace, "node --version");
    assert_eq!(result["exitCode"], 0, "node must run in the sandbox ({shell:?}): {result}\n{}", describe_node());
    assert!(
        output(&result).trim_start().starts_with('v'),
        "`node --version` printed no version ({shell:?}): {result}\n{}",
        describe_node()
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_active_shell_matches_the_machine() {
    // An independent oracle for the host's choice: Git Bash when one of the four fixed locations
    // has bin\bash.exe, otherwise Windows PowerShell.
    let candidates: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|name| std::env::var_os(name))
        .map(|root| PathBuf::from(root).join(r"Git\bin\bash.exe"))
        .chain(
            std::env::var_os("LOCALAPPDATA")
                .map(|root| PathBuf::from(root).join(r"Programs\Git\bin\bash.exe")),
        )
        .collect();
    let bash_present = candidates.iter().any(|path| path.is_file());
    let expected = if bash_present { Shell::GitBash } else { Shell::PowerShell };
    assert_eq!(
        active_shell(),
        expected,
        "the host's shell choice disagrees with the machine (bash.exe present: {bash_present}; looked at {candidates:?})"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_write_inside_the_workspace_with_the_pinned_environment() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let (result, env) = env_probe(&host, "write", &workspace, shell);
    let mut keys: Vec<&str> = result.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["cancelled", "exitCode", "output", "truncated"], "{result}");
    assert_eq!(result["exitCode"], 0, "{shell:?}: {result}");
    assert_eq!(result["cancelled"], false, "{result}");
    assert_eq!(result["truncated"], false, "{result}");
    assert_eq!(
        fs::read_to_string(workspace.path.join("out.txt")).unwrap_or_default(),
        "hello",
        "the sandbox must write inside the workspace ({shell:?}): {result}"
    );

    let root = wire(&workspace.path);
    let get = |key: &str| env[key].as_str().unwrap_or_default().to_string();
    assert_eq!(norm(&get("cwd")), norm(&root), "the command must start in the workspace ({shell:?}): {env}");
    assert_eq!(norm(&get("home")), norm(&root), "HOME must be pinned to the workspace ({shell:?}): {env}");
    assert_eq!(norm(&get("temp")), norm(&format!("{root}/.tmp")), "TEMP must be <workspace>/.tmp ({shell:?}): {env}");
    assert_eq!(norm(&get("tmp")), norm(&format!("{root}/.tmp")), "TMP must be <workspace>/.tmp ({shell:?}): {env}");
    assert_eq!(norm(&get("tmpdir")), norm(&format!("{root}/.tmp")), "Node's os.tmpdir() must be the workspace .tmp ({shell:?}): {env}");
    assert_eq!(norm(&get("npmCache")), norm(&format!("{root}/.cache/npm")), "npm_config_cache ({shell:?}): {env}");
    assert_eq!(norm(&get("pipCache")), norm(&format!("{root}/.cache/pip")), "PIP_CACHE_DIR ({shell:?}): {env}");
    assert_eq!(get("nodeUseEnvProxy"), "1", "NODE_USE_ENV_PROXY ({shell:?}): {env}");
    assert_eq!(get("tmpWrite"), "ok", "the pinned temp directory must be writable ({shell:?}): {env}");
    assert!(
        get("account").to_lowercase().contains("sourceweft-sandbox"),
        "the command must run as the sourceweft-sandbox account, not as the user ({shell:?}): {env}"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_cannot_read_secrets_in_the_profile_root_and_the_ssh_directory() {
    let shell = active_shell();
    let profile = profile_dir();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let root_secret = format!("sw-profile-root-secret-{id}");
    let ssh_secret = format!("sw-ssh-secret-{id}");

    let root_file = profile.join(format!(".sw-test-secret-{id}"));
    fs::write(&root_file, &root_secret).unwrap();
    let _root_cleanup = RemoveOnDrop(root_file.clone());

    let ssh = profile.join(".ssh");
    let created_ssh = !ssh.exists();
    fs::create_dir_all(&ssh).unwrap();
    let _ssh_cleanup = created_ssh.then(|| RemoveOnDrop(ssh.clone()));
    let ssh_file = ssh.join(format!("sw-test-key-{id}"));
    fs::write(&ssh_file, &ssh_secret).unwrap();
    let _ssh_file_cleanup = RemoveOnDrop(ssh_file.clone());

    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    assert!(
        !root_file.starts_with(&workspace.path) && !ssh_file.starts_with(&workspace.path),
        "precondition: the planted files must lie outside the workspace"
    );
    let result = read_probe(&host, "profile-root", &workspace, shell, &root_file);
    assert_read_denied(&result, &root_secret, "a file in the profile root");
    let result = read_probe(&host, "ssh", &workspace, shell, &ssh_file);
    assert_read_denied(&result, &ssh_secret, "a key in %USERPROFILE%\\.ssh");
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_cannot_write_outside_the_workspace() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let outside = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    // A sibling temp folder and the profile root (no access for the sandbox account at all), and
    // %SystemRoot%\Temp, where every ordinary user may create files: the sandbox account is in
    // `Users`, so only the write-restricted token (its restricting SIDs are the account, Everyone,
    // RESTRICTED and the session's write roots) keeps it out of there.
    let targets = [
        ("a sibling temp folder", outside.path().join("escape.txt")),
        ("the profile root", profile_dir().join(format!("sw-escape-{id}.txt"))),
        (
            "%SystemRoot%\\Temp (writable by Users, not by Everyone)",
            system_root().join("Temp").join(format!("sw-escape-{id}.txt")),
        ),
    ];
    let _cleanup: Vec<RemoveOnDrop> = targets.iter().map(|(_, path)| RemoveOnDrop(path.clone())).collect();
    for (what, target) in &targets {
        let result = write_probe(&host, "escape", &workspace, shell, target);
        assert_write_denied(&result, target, what);
    }
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_cannot_write_another_granted_workspace_but_can_read_it_known_limit() {
    // Writes are isolated per workspace (each session's token carries one capability SID per
    // root). READS ARE NOT: srt-win's design (its README: "Reads are not separated this way: any
    // sandboxed session can read a kept root") gives the sandbox group read access to every kept
    // write grant. A per-command read deny of the other roots is not viable (it would be stamped
    // on the shared account and block the other workspace's concurrent commands, at O(tree) cost).
    // So: writes must stay denied, and the read is asserted as a KNOWN LIMIT so that an srt change
    // is noticed rather than hidden.
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_secret = format!("sw-first-{}", uuid::Uuid::new_v4().simple());
    let second_secret = format!("sw-second-{}", uuid::Uuid::new_v4().simple());
    fs::write(first.path().join("secret.txt"), &first_secret).unwrap();
    fs::write(second.path().join("secret.txt"), &second_secret).unwrap();
    let (first_ws, first_root) = granted_workspace(&host, "first-thread", first.path());
    let (second_ws, second_root) = granted_workspace(&host, "second-thread", second.path());

    // Positive controls: each workspace reads its own file (this also starts both instances, so
    // they are alive side by side when the cross reads happen).
    for (label, ws, secret) in [("own-first", &first_ws, &first_secret), ("own-second", &second_ws, &second_secret)] {
        let own = read_probe(&host, label, ws, shell, Path::new("secret.txt"));
        assert!(
            output(&own).contains(&format!("READ-OK:{secret}")),
            "a workspace must read its own files ({shell:?}): {own}"
        );
    }
    let changed = |what: &str, result: &Value| {
        format!(
            "srt changed: cross-workspace reads are now isolated ({what}) - update WINDOWS_SANDBOX.md \
             (Limits) and the runtime prompt, then turn this into an isolation test. Result: {result}"
        )
    };
    let cross = read_probe(&host, "cross-read", &first_ws, shell, &second_root.join("secret.txt"));
    eprintln!("cross-workspace read (known limit): {cross}");
    assert!(
        output(&cross).contains(&format!("READ-OK:{second_secret}")),
        "{}",
        changed("first -> second", &cross)
    );
    let cross = read_probe(&host, "cross-read-back", &second_ws, shell, &first_root.join("secret.txt"));
    assert!(
        output(&cross).contains(&format!("READ-OK:{first_secret}")),
        "{}",
        changed("second -> first", &cross)
    );
    // Writes stay isolated, in both directions.
    let escape = second_root.join("escape.txt");
    let result = write_probe(&host, "cross-write", &first_ws, shell, &escape);
    assert_write_denied(&result, &escape, "another granted workspace");
    let escape = first_root.join("escape.txt");
    let result = write_probe(&host, "cross-write-back", &second_ws, shell, &escape);
    assert_write_denied(&result, &escape, "another granted workspace (the other direction)");
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_credential_directories_inside_a_granted_parent_are_denied_and_unwritable() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let parent = tempfile::tempdir().unwrap();
    let (grant, root) = host.grant_directory("owner", parent.path()).unwrap();
    // The policy protects credential stores under the *home* directory when they lie inside the
    // workspace or a read root (a deny anywhere else protects nothing, and an absent path would be
    // created as a placeholder). The real profile can never be inside a granted folder, so the
    // test points %USERPROFILE% at a stand-in profile inside the granted parent for the duration
    // of the commands. The host grant above was checked against the real profile.
    let home = root.join("home");
    let ssh = home.join(".ssh");
    let credentials = home.join(r"AppData\Roaming\Microsoft\Credentials");
    fs::create_dir_all(&ssh).unwrap();
    fs::create_dir_all(&credentials).unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let ssh_secret = format!("sw-ssh-{id}");
    let credentials_secret = format!("sw-credentials-{id}");
    fs::write(home.join("notes.txt"), "notes-visible").unwrap();
    fs::write(ssh.join("id_sw"), &ssh_secret).unwrap();
    fs::write(credentials.join("sw-blob"), &credentials_secret).unwrap();
    write_scripts(&root);
    let workspace = host
        .ensure_workspace_with_grant("owner", "thread", Some(&grant))
        .unwrap();
    let _profile = EnvGuard::set("USERPROFILE", &home);

    let notes = read_probe(&host, "notes", &workspace, shell, &home.join("notes.txt"));
    assert!(
        output(&notes).contains("READ-OK:notes-visible"),
        "positive control: the rest of the granted folder must stay readable ({shell:?}): {notes}"
    );
    let result = read_probe(&host, "ssh-read", &workspace, shell, &ssh.join("id_sw"));
    assert_read_denied(&result, &ssh_secret, ".ssh inside a granted folder");
    let result = read_probe(&host, "credentials-read", &workspace, shell, &credentials.join("sw-blob"));
    assert_read_denied(&result, &credentials_secret, "the Credentials store inside a granted folder");

    let new_key = ssh.join("sw-new-key");
    let result = write_probe(&host, "ssh-create", &workspace, shell, &new_key);
    assert_write_denied(&result, &new_key, "a new file in .ssh inside a granted folder");
    let overwrite = write_probe(&host, "ssh-overwrite", &workspace, shell, &ssh.join("id_sw"));
    let line = output(&overwrite).lines().find(|l| l.starts_with("WRITE-")).unwrap_or("");
    assert!(
        line == "WRITE-ERR:EACCES" || line == "WRITE-ERR:EPERM",
        "overwriting a key in .ssh must be refused, got {line:?}: {overwrite}"
    );
    assert_eq!(
        fs::read_to_string(ssh.join("id_sw")).unwrap(),
        ssh_secret,
        "the key was modified by a refused write"
    );
    let new_blob = credentials.join("sw-new");
    let result = write_probe(&host, "credentials-create", &workspace, shell, &new_blob);
    assert_write_denied(&result, &new_blob, "a new file in the Credentials store");

    let fine = home.join("new-ok.txt");
    let result = write_probe(&host, "other-write", &workspace, shell, &fine);
    assert!(
        output(&result).contains("WRITE-OK") && fine.is_file(),
        "positive control: the rest of the granted folder must stay writable ({shell:?}): {result}"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_workspace_with_spaces_brackets_cjk_and_apostrophes() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let parent = tempfile::tempdir().unwrap();
    let selected = parent.path().join("ws [\u{6d4b}\u{8bd5}] it's $x a b");
    fs::create_dir(&selected).unwrap();
    let (workspace, root) = granted_workspace(&host, "granted-thread", &selected);
    let (result, env) = env_probe(&host, "special", &workspace, shell);
    assert_eq!(result["exitCode"], 0, "{shell:?}: {result}");
    let wire_root = wire(&root);
    let get = |key: &str| env[key].as_str().unwrap_or_default().to_string();
    assert_eq!(norm(&get("cwd")), norm(&wire_root), "cwd ({shell:?}): {env}");
    assert_eq!(norm(&get("home")), norm(&wire_root), "HOME must survive the quoting ({shell:?}): {env}");
    assert_eq!(norm(&get("temp")), norm(&format!("{wire_root}/.tmp")), "TEMP must survive the quoting ({shell:?}): {env}");
    assert_eq!(fs::read_to_string(root.join("out.txt")).unwrap_or_default(), "hello", "{result}");
    assert_eq!(
        fs::read_to_string(root.join("a [b] \u{6d4b}\u{8bd5} it's.txt")).unwrap_or_default(),
        "ok",
        "a file with spaces, brackets, CJK and an apostrophe must be created in the folder ({shell:?}): {result}"
    );
}

// ---------------------------------------------------------------------------------------------
// Ancestor traversal: the sandbox account can resolve the path it runs in (and nothing more).
// ---------------------------------------------------------------------------------------------

/// A fresh directory directly under the user's profile, removed with the guard. Workspaces under
/// it are in the profile like production's `%APPDATA%\<app>\task-workspaces\<id>`.
fn profile_scratch(prefix: &str) -> (tempfile::TempDir, PathBuf) {
    let profile = profile_dir();
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(&profile)
        .unwrap_or_else(|error| panic!("cannot create a scratch directory under {profile:?}: {error}"));
    let root = canonical(dir.path());
    (dir, root)
}

/// What the DACL of a directory looks like, from Windows PowerShell: the SDDL of the access list
/// (`D:` flags first: `P` protected, `AI` auto-inherited) and one line per entry.
struct AclReport {
    sddl: String,
    aces: Vec<String>,
}

impl AclReport {
    /// The flags before the first entry, e.g. `D:PAI`.
    fn flags(&self) -> &str {
        self.sddl.split('(').next().unwrap_or("")
    }

    fn sandbox_entries(&self) -> Vec<&String> {
        self.aces.iter().filter(|line| line.contains("sourceweft-sandbox")).collect()
    }

    fn others(&self) -> Vec<&String> {
        self.aces.iter().filter(|line| !line.contains("sourceweft-sandbox")).collect()
    }
}

fn acl_report(dir: &Path) -> AclReport {
    let literal = dir.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $a = Get-Acl -LiteralPath '{literal}'\n\
         'SDDL ' + $a.GetSecurityDescriptorSddlForm('Access')\n\
         foreach ($r in $a.Access) {{ 'ACE ' + $r.IdentityReference + '|' + $r.AccessControlType + '|' + [int]$r.FileSystemRights + '|' + $r.InheritanceFlags + '|' + $r.PropagationFlags + '|' + $r.IsInherited + '|' + $r.FileSystemRights }}\n"
    );
    let (ok, text) = host_powershell(&script);
    assert!(ok, "Get-Acl failed for {dir:?}: {text}");
    let sddl = text
        .lines()
        .find_map(|line| line.trim_end().strip_prefix("SDDL "))
        .unwrap_or_else(|| panic!("no SDDL line for {dir:?}: {text}"))
        .to_string();
    let aces = text
        .lines()
        .filter_map(|line| line.trim_end().strip_prefix("ACE "))
        .map(str::to_string)
        .collect();
    AclReport { sddl, aces }
}

/// The access mask the grant is specified to carry: FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
/// READ_CONTROL | SYNCHRONIZE.
const TRAVERSE_MASK: &str = "1179808";

fn ancestor_record(app: &Path) -> Option<Value> {
    let text = fs::read_to_string(app.join("sandbox").join("ancestor-grants.json")).ok()?;
    Some(serde_json::from_str(&text).expect("ancestor-grants.json is JSON"))
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn a_node_script_in_a_workspace_under_the_profile_runs() {
    // The regression for the ancestor bug (17 failures in the first CI run): Node's realpathSync
    // lstat's every ancestor of the script, and the sandbox account could not stat `...\AppData`.
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let (_scratch, scratch) = profile_scratch("sw-anc-run-");
    let nested = scratch.join("one").join("two");
    fs::create_dir_all(&nested).unwrap();
    let (workspace, root) = granted_workspace(&host, "deep-thread", &nested);
    assert!(root.starts_with(profile_dir()), "precondition: {root:?} must be inside the profile");
    let (result, env) = env_probe(&host, "deep", &workspace, shell);
    assert_eq!(result["exitCode"], 0, "a Node script in a profile workspace must run ({shell:?}): {result}");
    assert_eq!(norm(env["cwd"].as_str().unwrap_or_default()), norm(&wire(&root)), "{env}");
    assert_eq!(fs::read_to_string(root.join("out.txt")).unwrap_or_default(), "hello", "{result}");

    // The automatic workspace (`<app data>/task-workspaces/<id>/files`, here under %TEMP%) is the
    // production layout; it must run a script too.
    let automatic = new_workspace(&host, "auto-thread");
    let (result, _) = env_probe(&host, "auto", &automatic, shell);
    assert_eq!(result["exitCode"], 0, "a Node script in an automatic workspace must run ({shell:?}): {result}");
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn the_ancestor_grant_allows_lstat_but_no_directory_listing() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let base = std::env::temp_dir();
    let parent = if canonical(&base).starts_with(profile_dir()) { base } else { profile_dir() };
    let dir = tempfile::Builder::new()
        .prefix("sw-list-")
        .tempdir_in(&parent)
        .unwrap();
    let nested = canonical(dir.path()).join("ws");
    fs::create_dir_all(&nested).unwrap();
    fs::write(canonical(dir.path()).join("sibling.txt"), "x").unwrap();
    let (workspace, root) = granted_workspace(&host, "list-thread", &nested);

    // Every strict ancestor inside the profile, profile first.
    let profile = profile_dir();
    let mut ancestors: Vec<PathBuf> = root
        .ancestors()
        .skip(1)
        .take_while(|path| path.starts_with(&profile))
        .map(Path::to_path_buf)
        .collect();
    ancestors.reverse();
    assert!(
        ancestors.len() >= 2 && ancestors[0] == profile,
        "precondition: expected the profile and at least one directory below it, got {ancestors:?}"
    );
    let names: Vec<String> = ancestors.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let control = workspace.path.join(".sw-control");
    let _ = fs::remove_file(&control);
    let result = execute(&host, "list", &workspace, &node(shell, "sw-list.cjs", &refs));
    assert_eq!(
        fs::read_to_string(&control).ok().as_deref(),
        Some("ran"),
        "the sandboxed Node never ran in the workspace, so the results below would prove nothing: {result}"
    );
    let lines: Vec<Value> = output(&result)
        .lines()
        .filter_map(|line| line.strip_prefix("LIST "))
        .map(|line| serde_json::from_str(line).expect("LIST line is JSON"))
        .collect();
    assert_eq!(lines.len(), ancestors.len(), "one LIST line per directory: {result}");
    // The directories whose lists no one but the user can read on any Windows install: the
    // profile, its AppData, and the scratch directory this test created. (Other ancestors, such as
    // %TEMP%, are listed in the log but not asserted: a machine's own ACLs may admit more there.)
    let must_refuse = [
        profile.clone(),
        profile.join("AppData"),
        canonical(dir.path()),
    ];
    for line in &lines {
        eprintln!("ancestor as the sandbox sees it: {line}");
        assert_eq!(line["lstat"], "dir", "lstat of an ancestor must work (the grant): {line}");
        let listed = PathBuf::from(line["dir"].as_str().unwrap_or_default());
        if must_refuse.iter().any(|path| norm(&path.to_string_lossy()) == norm(&listed.to_string_lossy())) {
            let listing = line["readdir"].as_str().unwrap_or_default();
            assert!(
                listing == "ERR:EACCES" || listing == "ERR:EPERM",
                "listing {listed:?} must be refused (the grant has no FILE_LIST_DIRECTORY), got {listing:?}: {line}"
            );
        }
    }
    assert!(
        lines.iter().any(|line| line["dir"].as_str().is_some_and(|d| norm(d) == norm(&profile.to_string_lossy()))),
        "the profile directory itself must have been probed: {lines:?}"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn ancestor_grants_are_exact_idempotent_and_revocable() {
    let shell = active_shell();
    let (app, host) = host_with_bundle();
    let (_scratch, scratch) = profile_scratch("sw-anc-acl-");
    let first = scratch.join("a").join("b");
    fs::create_dir_all(&first).unwrap();
    // Two directories only this test has ever touched: the scratch directory and its child `a`.
    let touched = [scratch.clone(), scratch.join("a")];
    let before: Vec<AclReport> = touched.iter().map(|dir| acl_report(dir)).collect();
    for (dir, report) in touched.iter().zip(&before) {
        assert!(report.sandbox_entries().is_empty(), "precondition: {dir:?} has no sandbox entry yet: {:?}", report.aces);
    }

    // Starting a sandbox for the workspace grants traversal on the directories above it.
    let (workspace, _) = granted_workspace(&host, "acl-1", &first);
    let (result, _) = env_probe(&host, "acl-1", &workspace, shell);
    assert_eq!(result["exitCode"], 0, "{result}");
    let after: Vec<AclReport> = touched.iter().map(|dir| acl_report(dir)).collect();
    for ((dir, was), now) in touched.iter().zip(&before).zip(&after) {
        let ours = now.sandbox_entries();
        assert_eq!(ours.len(), 1, "exactly one sandbox entry on {dir:?}: {:?}", now.aces);
        // IdentityReference|Allow|mask|InheritanceFlags|PropagationFlags|IsInherited|rights
        let fields: Vec<&str> = ours[0].split('|').collect();
        assert_eq!(fields[1], "Allow", "{dir:?}: {}", ours[0]);
        assert_eq!(fields[2], TRAVERSE_MASK, "mask of {dir:?} (traverse + read attributes + read control + synchronize): {}", ours[0]);
        assert_eq!(fields[3], "None", "children must not inherit it ({dir:?}): {}", ours[0]);
        assert_eq!(fields[5], "False", "an explicit entry ({dir:?}): {}", ours[0]);
        assert_eq!(now.others(), was.others(), "every other entry of {dir:?} is unchanged");
        assert_eq!(now.flags(), was.flags(), "the protection flags of {dir:?} are unchanged");
    }

    // It is recorded, so it can be taken back exactly.
    let record = ancestor_record(app.path()).expect("the grants are recorded in <app data>/sandbox/ancestor-grants.json");
    let recorded = |dir: &Path| {
        record["grants"].as_array().unwrap().iter().any(|grant| {
            grant["path"].as_str().is_some_and(|path| norm(path) == norm(&dir.to_string_lossy()))
        })
    };
    for dir in &touched {
        assert!(recorded(dir), "{dir:?} must be in the record: {record}");
    }

    // A second workspace under the same parents changes nothing on them.
    let second = scratch.join("a").join("c");
    fs::create_dir_all(&second).unwrap();
    let (workspace2, _) = granted_workspace(&host, "acl-2", &second);
    let (result, _) = env_probe(&host, "acl-2", &workspace2, shell);
    assert_eq!(result["exitCode"], 0, "{result}");
    for (dir, was) in touched.iter().zip(&after) {
        assert_eq!(acl_report(dir).sddl, was.sddl, "a second start must be a no-op on {dir:?}");
    }
    assert_eq!(ancestor_record(app.path()), Some(record), "the record is unchanged by a no-op");

    // Revocation removes exactly what was added.
    host.revoke_ancestor_grants()
        .unwrap_or_else(|error| panic!("revoking the ancestor grants failed: {error}"));
    for (dir, was) in touched.iter().zip(&before) {
        let now = acl_report(dir);
        assert!(now.sandbox_entries().is_empty(), "{dir:?} still has a sandbox entry: {:?}", now.aces);
        assert_eq!(now.sddl, was.sddl, "revocation must restore the original access list of {dir:?} exactly");
    }
    assert!(
        ancestor_record(app.path()).is_none(),
        "the record is removed once everything in it was revoked"
    );

    // And the sandbox grants again when the next workspace starts.
    let third = scratch.join("a").join("d");
    fs::create_dir_all(&third).unwrap();
    let (workspace3, _) = granted_workspace(&host, "acl-3", &third);
    let (result, _) = env_probe(&host, "acl-3", &workspace3, shell);
    assert_eq!(result["exitCode"], 0, "after a revocation the next start grants again: {result}");
    assert_eq!(acl_report(&scratch).sandbox_entries().len(), 1);
    host.revoke_ancestor_grants().unwrap();
}

// ---------------------------------------------------------------------------------------------
// Process lifetime: cancel, timeout, exit codes, output cap.
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
struct Tree {
    pids: Vec<u32>,
    ping_count: String,
    marker: String,
}

impl Tree {
    fn needles(&self) -> Vec<String> {
        vec![format!("ping -n {} 127.0.0.1", self.ping_count), self.marker.clone()]
    }

    fn survivors(&self) -> Vec<String> {
        let needles = self.needles();
        let refs: Vec<&str> = needles.iter().map(String::as_str).collect();
        live_matches(&self.pids, &refs)
    }
}

/// Waits for `sw-tree.cjs` to report its processes, then for the query to see them.
fn wait_for_tree(root: &Path, ping_count: String, marker: String) -> Tree {
    let file = root.join("tree.json");
    assert!(
        wait_until(Duration::from_secs(90), || file.is_file()),
        "the process tree never started (no tree.json in the workspace within 90 s); the sandboxed Node did not run"
    );
    let value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    let pids = ["self", "cmd", "node"]
        .iter()
        .map(|key| value[*key].as_u64().unwrap() as u32)
        .collect();
    let tree = Tree { pids, ping_count, marker };
    // Give ping a moment to start, then prove the survivor query can see this tree at all: a blind
    // query would make the zero-survivor assertion meaningless.
    assert!(
        wait_until(Duration::from_secs(20), || tree.survivors().len() >= 3),
        "the survivor query could not see the running process tree (expected the node, cmd and ping processes), saw {:?}",
        tree.survivors()
    );
    tree
}

fn assert_no_survivors(tree: &Tree, what: &str) {
    assert!(
        wait_until(Duration::from_secs(15), || tree.survivors().is_empty()),
        "{what} left processes running in the sandbox (by pid and by command line): {:?}",
        tree.survivors()
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_cancel_kills_the_whole_process_tree() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let host = Arc::new(host);
    let workspace = new_workspace(&host, "thread");
    let executions = Arc::new(Executions::default());
    let ping = unique_ping_count();
    let marker = format!("swmark{}", uuid::Uuid::new_v4().simple());
    let command = node(shell, "sw-tree.cjs", &[ping.as_str(), marker.as_str()]);
    let worker = {
        let host = host.clone();
        let executions = executions.clone();
        let workspace = workspace.clone();
        std::thread::spawn(move || {
            let _w = watch("command.execute `cancel-tree`", Duration::from_secs(260));
            host.dispatch(
                &executions,
                "cancel-tree",
                "owner",
                &workspace.thread_id,
                "command.execute",
                json!({"workspaceId": workspace.id, "command": command, "timeoutMs": 110000}),
            )
        })
    };
    let tree = wait_for_tree(&workspace.path, ping, marker);
    assert!(executions.cancel("cancel-tree"), "the running command must be known to the executions table");
    let result = worker.join().unwrap().unwrap();
    assert_eq!(result["cancelled"], true, "{result}");
    assert_eq!(result["exitCode"], 124, "{result}");
    assert_no_survivors(&tree, "cancelling the command");
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_timeout_kills_the_whole_process_tree() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let host = Arc::new(host);
    let workspace = new_workspace(&host, "thread");
    // Warm the instance first, so the 25 s limit below is spent on the tree, not on starting a
    // sidecar and stamping the workspace.
    let warm = execute(&host, "warm", &workspace, &node(shell, "sw-exit.cjs", &["0"]));
    assert_eq!(warm["exitCode"], 0, "{warm}");
    let ping = unique_ping_count();
    let marker = format!("swmark{}", uuid::Uuid::new_v4().simple());
    let command = node(shell, "sw-tree.cjs", &[ping.as_str(), marker.as_str()]);
    let started = Instant::now();
    let result = try_execute(&host, &Executions::default(), "timeout", &workspace, &command, 25_000, 20_000)
        .unwrap_or_else(|error| panic!("command.execute failed: {error}"));
    assert_eq!(result["cancelled"], true, "a timed-out command is reported as cancelled: {result}");
    assert_eq!(result["exitCode"], 124, "{result}");
    assert!(
        started.elapsed() < Duration::from_secs(60),
        "the timeout of 25 s took {:?} to take effect",
        started.elapsed()
    );
    let file = workspace.path.join("tree.json");
    assert!(
        file.is_file(),
        "the tree never started within the 25 s limit, so the timeout kill was not exercised: {result}"
    );
    let value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    let pids = ["self", "cmd", "node"].iter().map(|key| value[*key].as_u64().unwrap() as u32).collect();
    assert_no_survivors(&Tree { pids, ping_count: ping, marker }, "a timeout");
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_exit_codes_pass_through() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let result = execute(&host, "exit-7", &workspace, "exit 7");
    assert_eq!(result["exitCode"], 7, "`exit 7` ({shell:?}): {result}");
    assert_eq!(result["cancelled"], false, "{result}");
    let command = match shell {
        Shell::GitBash => "node sw-exit.cjs 3".to_string(),
        Shell::PowerShell => "node sw-exit.cjs 3; exit $LASTEXITCODE".to_string(),
    };
    let result = execute(&host, "exit-3", &workspace, &command);
    assert_eq!(result["exitCode"], 3, "a failing program's exit code must reach the result ({shell:?}): {result}");
    let result = execute(&host, "exit-0", &workspace, &node(shell, "sw-exit.cjs", &["0"]));
    assert_eq!(result["exitCode"], 0, "{result}");
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn shells_output_is_capped() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let result = try_execute(
        &host,
        &Executions::default(),
        "big",
        &workspace,
        &node(shell, "sw-big.cjs", &["200000"]),
        110_000,
        5_000,
    )
    .unwrap_or_else(|error| panic!("command.execute failed: {error}"));
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(result["truncated"], true, "200000 characters against a 5000 cap must be reported as truncated ({shell:?})");
    assert!(
        output(&result).chars().count() <= 5_000,
        "the output must be cut at the cap, got {} characters",
        output(&result).chars().count()
    );
}

// ---------------------------------------------------------------------------------------------
// Instances: concurrency, the cap of four, eviction.
// ---------------------------------------------------------------------------------------------

/// Starts `node sw-hold.cjs <name> <seconds>` in `workspace` on a thread. The command id is
/// `id`, so the caller can cancel it.
fn spawn_hold(
    host: &Arc<LocalHost>,
    executions: &Arc<Executions>,
    shell: Shell,
    id: &str,
    workspace: &Workspace,
    name: &str,
    seconds: u32,
) -> std::thread::JoinHandle<Result<Value, HostError>> {
    let host = host.clone();
    let executions = executions.clone();
    let workspace = workspace.clone();
    let id = id.to_string();
    let seconds = seconds.to_string();
    let command = node(shell, "sw-hold.cjs", &[name, seconds.as_str()]);
    std::thread::spawn(move || {
        let _w = watch(format!("command.execute `{id}`"), Duration::from_secs(260));
        host.dispatch(
            &executions,
            &id,
            "owner",
            &workspace.thread_id,
            "command.execute",
            json!({"workspaceId": workspace.id, "command": command, "timeoutMs": 110000}),
        )
    })
}

fn epoch_ms(path: &Path) -> u128 {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{path:?} was not written: {error}"))
        .trim()
        .parse()
        .unwrap()
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn two_workspaces_run_concurrently() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let host = Arc::new(host);
    let executions = Arc::new(Executions::default());
    let a = new_workspace(&host, "thread-a");
    let b = new_workspace(&host, "thread-b");
    let first = spawn_hold(&host, &executions, shell, "hold-a", &a, "hold", 12);
    let second = spawn_hold(&host, &executions, shell, "hold-b", &b, "hold", 12);
    for result in [first.join().unwrap(), second.join().unwrap()] {
        let result = result.unwrap_or_else(|error| panic!("a held command failed: {error}"));
        assert_eq!(result["exitCode"], 0, "{result}");
    }
    let (a_start, a_end) = (epoch_ms(&a.path.join("hold.started")), epoch_ms(&a.path.join("hold.finished")));
    let (b_start, b_end) = (epoch_ms(&b.path.join("hold.started")), epoch_ms(&b.path.join("hold.finished")));
    assert!(
        a_start < b_end && b_start < a_end,
        "the two workspaces ran one after the other, not concurrently: a {a_start}..{a_end}, b {b_start}..{b_end}"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn instance_cap_evicts_an_idle_instance_and_refuses_when_all_are_busy() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let host = Arc::new(host);
    let executions = Arc::new(Executions::default());
    let workspaces: Vec<Workspace> = (0..6).map(|n| new_workspace(&host, &format!("thread-{n}"))).collect();
    let quick = |index: usize, label: &str| {
        let result = execute(&host, label, &workspaces[index], &node(shell, "sw-exit.cjs", &["0"]));
        assert_eq!(result["exitCode"], 0, "{label}: {result}");
    };
    // Four idle instances fill the cap; a fifth workspace must evict the least recently used one
    // instead of failing.
    for index in 0..4 {
        quick(index, "fill");
    }
    quick(4, "fifth-evicts-an-idle-instance");

    // Four running commands in the four live workspaces (1..=4): every instance is busy.
    let holds: Vec<_> = (1..=4)
        .map(|index| {
            spawn_hold(&host, &executions, shell, &format!("busy-{index}"), &workspaces[index], "busy", 100)
        })
        .collect();
    for index in 1..=4 {
        let file = workspaces[index].path.join("busy.started");
        assert!(
            wait_until(Duration::from_secs(90), || file.is_file()),
            "the busy command in workspace {index} never started"
        );
    }
    let refused = try_execute(
        &host,
        &Executions::default(),
        "sixth-while-all-busy",
        &workspaces[5],
        &node(shell, "sw-exit.cjs", &["0"]),
        30_000,
        2_000,
    );
    let mut cancelled = 0;
    for index in 1..=4 {
        if executions.cancel(&format!("busy-{index}")) {
            cancelled += 1;
        }
    }
    for hold in holds {
        let _ = hold.join();
    }
    assert_eq!(cancelled, 4, "all four busy commands must have been running");
    match refused {
        Err(error) => assert_eq!(
            error.code, "SANDBOX_BUSY",
            "with every instance running a command the next workspace must be refused with SANDBOX_BUSY, got {error}"
        ),
        Ok(result) => panic!("a fifth concurrent workspace must be refused, but it ran: {result}"),
    }
    // Once the commands have ended the instances are idle again and a new workspace evicts one.
    quick(5, "after-release");
}

// ---------------------------------------------------------------------------------------------
// Network: what the sandbox proxy lets through, and what it refuses.
// ---------------------------------------------------------------------------------------------

fn probe_line(result: &Value) -> Value {
    let line = line_with(output(result), "PROBE ")
        .unwrap_or_else(|| panic!("sw-net.cjs printed no PROBE line: {result}\n{}", describe_node()));
    serde_json::from_str(line).unwrap_or_else(|error| panic!("PROBE line is not JSON ({error}): {line}"))
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn public_https_is_allowed_through_node() {
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let result = execute(
        &host,
        "public",
        &workspace,
        &node(shell, "sw-net.cjs", &["GET", "https://registry.npmjs.org/left-pad"]),
    );
    let probe = probe_line(&result);
    assert_eq!(
        probe["status"], 200,
        "Node (OpenSSL TLS) must reach a public HTTPS site through the sandbox proxy ({shell:?}): {result}"
    );
}

fn git_bash_install_root() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|name| std::env::var_os(name))
        .map(|root| PathBuf::from(root).join("Git"))
        .chain(std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join(r"Programs\Git")))
        .find(|root| root.join(r"bin\bash.exe").is_file())
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn git_for_windows_https_works() {
    let shell = active_shell();
    if git_bash_install_root().is_none() {
        eprintln!("SKIPPED: Git for Windows is not installed in a fixed location on this machine");
        return;
    }
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    // git itself (OpenSSL backend, injected by srt: Schannel cannot get credentials under the
    // write-restricted token). Git's own curl.exe is a different matter: see
    // `git_bash_curl_is_a_schannel_client_known_limit`.
    let result = execute(
        &host,
        "git",
        &workspace,
        "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
    );
    assert_eq!(result["exitCode"], 0, "git over HTTPS must work under the sandbox ({shell:?}): {result}");
    assert!(output(&result).contains("\tHEAD"), "git ls-remote printed no HEAD: {result}");
}

/// The `curl --version` lines that say how it was built, for the log (and for failure messages).
fn curl_build(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let lower = line.to_lowercase();
            lower.starts_with("curl ") || lower.starts_with("features:") || lower.starts_with("protocols:")
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn git_bash_curl_is_a_schannel_client_known_limit() {
    // KNOWN LIMIT (real CI evidence, windows-2025): plain `curl` in Git Bash fails HTTPS under the
    // sandbox with `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`. Git for
    // Windows' curl is built against Schannel, like System32's. So the runtime prompt must NOT
    // promise that `curl` works in Git Bash; Node, Python, `git` (srt injects OpenSSL for it) and
    // Java/Go are the HTTPS clients that work. This test asserts the failure (so a future srt fix
    // is noticed, not hidden), prints where plain `curl` resolves to and how it is built.
    // (An earlier version also called `<Git>\mingw64\bin\curl.exe`: that path does not exist on the
    // runner's Git layout, so the binary is taken from `command -v curl` instead.)
    if active_shell() != Shell::GitBash {
        eprintln!("SKIPPED: the host is not using Git Bash on this machine (no Git\\bin\\bash.exe)");
        return;
    }
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");

    // Which binary plain `curl` is, and how it is built (printed so a CI log answers "which TLS
    // backend?" without another run).
    let which = execute(&host, "curl-which", &workspace, "command -v curl");
    eprintln!("plain curl resolves to: {}", output(&which).trim());
    let plain_version = execute(&host, "curl-version", &workspace, "curl --version");
    eprintln!("plain `curl --version`:\n{}", output(&plain_version));
    eprintln!("curl build: {}", curl_build(output(&plain_version)));
    assert_eq!(plain_version["exitCode"], 0, "`curl --version` must run in Git Bash: {plain_version}");
    assert!(
        output(&plain_version).to_lowercase().contains("curl "),
        "`curl --version` printed no version: {plain_version}"
    );

    let url = "https://registry.npmjs.org/left-pad";
    let plain = execute(
        &host,
        "plain-curl",
        &workspace,
        &format!("curl -sS -m 30 -o /dev/null -w '%{{http_code}}' {url}"),
    );
    eprintln!("plain curl: {plain}");
    let fails_like_schannel = |result: &Value| {
        let text = output(result);
        result["exitCode"] != 0
            && !text.contains("200")
            && (result["exitCode"] == 35 || text.to_lowercase().contains("schannel"))
    };
    assert!(
        fails_like_schannel(&plain),
        "KNOWN LIMIT CHANGED or something else broke: plain `curl` in Git Bash was expected to fail \
         HTTPS the way Schannel clients do (exit 35 / schannel message). If it now works, the \
         limitation may be fixed: update WINDOWS_SANDBOX.md and the runtime prompt, then replace this \
         test. Result: {plain}"
    );
}

/// Proxy variables a host-side child must not inherit (this process's are poisoned by the job).
const PROXY_VARIABLES: [&str; 12] = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
    "all_proxy", "no_proxy", "FTP_PROXY", "ftp_proxy", "GRPC_PROXY", "grpc_proxy",
];

fn without_proxies(mut command: Command) -> Command {
    for name in PROXY_VARIABLES {
        command.env_remove(name);
    }
    command
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn schannel_clients_cannot_do_https_under_the_sandbox_known_limit() {
    // KNOWN LIMIT, asserted so that a future srt fix is noticed rather than hidden: Schannel
    // cannot acquire credentials under the write-restricted token, so System32 `curl.exe`,
    // PowerShell's `Invoke-WebRequest`, .NET `HttpClient` and every other Schannel client fail
    // HTTPS in the sandbox. Node, Python, Java, Go and Git for Windows (OpenSSL) work. The same
    // requests succeed outside the sandbox, which the controls below prove. When this test starts
    // failing because the clients work, update WINDOWS_SANDBOX.md and the runtime prompt.
    let shell = active_shell();
    let url = "https://registry.npmjs.org/left-pad";
    let curl = system_root().join(r"System32\curl.exe");

    // Controls, on the host and without the poisoned proxy variables.
    let mut control_curl = without_proxies(Command::new(&curl));
    control_curl.args(["-sS", "-m", "30", "-o", "NUL", "-w", "%{http_code}", url]);
    let control = run_bounded(control_curl, HELPER_LIMIT, "System32 curl.exe on the host");
    assert_eq!(
        String::from_utf8_lossy(&control.stdout).trim(),
        "200",
        "control: System32 curl.exe must reach {url} outside the sandbox ({}): {}",
        control.status,
        String::from_utf8_lossy(&control.stderr)
    );
    let iwr = format!(
        "try {{ $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 {url}; 'IWR-STATUS ' + $r.StatusCode }} catch {{ 'IWR-FAILED ' + $_.Exception.Message }}"
    );
    let mut control_iwr = without_proxies(Command::new(windows_powershell()));
    control_iwr
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
        .arg(encoded(&iwr));
    let control = run_bounded(control_iwr, HELPER_LIMIT, "PowerShell on the host");
    assert!(
        String::from_utf8_lossy(&control.stdout).contains("IWR-STATUS 200"),
        "control: Invoke-WebRequest must reach {url} outside the sandbox: {}{}",
        String::from_utf8_lossy(&control.stdout),
        String::from_utf8_lossy(&control.stderr)
    );

    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let command = call(shell, &curl, &format!("-sS -m 30 -o NUL -w '%{{http_code}}' {url}"));
    let result = execute(&host, "schannel-curl", &workspace, &command);
    let text = output(&result);
    assert!(
        result["exitCode"] != 0 && !text.contains("200"),
        "KNOWN LIMIT CHANGED: System32 curl.exe now reaches HTTPS under the sandbox. The Schannel \
         limitation may be fixed: update WINDOWS_SANDBOX.md and the runtime prompt, then replace \
         this test. Result: {result}"
    );
    assert!(
        result["exitCode"] == 35 || text.to_lowercase().contains("schannel"),
        "System32 curl.exe failed, but not the way the documented limitation fails (expected exit \
         35 or an schannel message); the cause may be something else, such as the proxy or Node's \
         read access: {result}"
    );

    let command = sandboxed_powershell(shell, &iwr);
    let result = execute(&host, "schannel-iwr", &workspace, &command);
    let text = output(&result);
    assert!(
        text.contains("IWR-FAILED") && !text.contains("IWR-STATUS 200"),
        "KNOWN LIMIT CHANGED or PowerShell could not run: Invoke-WebRequest is expected to fail HTTPS \
         under the sandbox. Result: {result}"
    );
}

/// A listener bound only to the host's 127.0.0.1 that answers every connection with a unique
/// marker. A sandboxed command that ever sees the marker reached host loopback.
fn host_only_listener() -> (u16, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let marker = format!("HOST-LOOPBACK-REACHED-{}", uuid::Uuid::new_v4().simple());
    let reply = format!("HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{marker}", marker.len());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (port, marker)
}

fn connect_probe(host: &LocalHost, workspace: &Workspace, shell: Shell, target: &str) -> Value {
    execute(host, &format!("connect-{target}"), workspace, &node(shell, "sw-connect.cjs", &[target]))
}

fn socks_probe(host: &LocalHost, workspace: &Workspace, shell: Shell, dest: &str, port: u16) -> Value {
    execute(
        host,
        &format!("socks-{dest}-{port}"),
        workspace,
        &node(shell, "sw-socks.cjs", &[dest, port.to_string().as_str()]),
    )
}

/// The proxy answered the CONNECT and refused it with a 403.
fn assert_connect_refused(result: &Value, target: &str, marker: Option<&str>) {
    let text = output(result);
    let line = line_with(text, "CONNECT ")
        .unwrap_or_else(|| panic!("sw-connect.cjs printed no CONNECT line for {target}: {result}"));
    let reply: Value = serde_json::from_str(line).unwrap_or_else(|error| panic!("CONNECT line is not JSON ({error}): {line}"));
    assert_eq!(
        reply["status"], 403,
        "CONNECT {target} must be refused with 403 by the sandbox proxy: {result}"
    );
    if let Some(marker) = marker {
        assert!(!text.contains(marker), "CONNECT {target} reached the host-only listener: {result}");
    }
}

/// The SOCKS handshake and authentication succeeded (so the probe really talked to the proxy),
/// and the CONNECT itself was refused.
fn assert_socks_refused(result: &Value, dest: &str, marker: Option<&str>) {
    let text = output(result);
    assert!(
        text.contains("greeting=0502") && text.contains("auth=0100"),
        "the SOCKS probe never authenticated with the sandbox proxy for {dest}: {result}"
    );
    let reply = line_with(text, "reply=").unwrap_or_default();
    assert!(
        reply.len() == 4 && reply.starts_with("05") && reply != "0500",
        "SOCKS CONNECT to {dest} must be refused (got reply {reply:?}): {result}"
    );
    if let Some(marker) = marker {
        assert!(!text.contains(marker), "SOCKS CONNECT to {dest} reached the host-only listener: {result}");
    }
}

/// Spellings of host loopback that an inet_aton-style parser (and the WHATWG URL parser srt dials
/// through) turns into 127.0.0.1.
const LOOPBACK_SPELLINGS: [&str; 4] = ["127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1"];

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn connect_to_loopback_spellings_is_refused() {
    let shell = active_shell();
    let (port, marker) = host_only_listener();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    for spelling in LOOPBACK_SPELLINGS {
        let target = format!("{spelling}:{port}");
        let result = connect_probe(&host, &workspace, shell, &target);
        assert_connect_refused(&result, &target, Some(marker.as_str()));
        assert!(
            output(&result).contains("public internet only"),
            "CONNECT {target} must be refused by the sidecar's address guard: {result}"
        );
    }
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn socks_to_loopback_spellings_is_refused() {
    let shell = active_shell();
    let (port, marker) = host_only_listener();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    for spelling in LOOPBACK_SPELLINGS {
        let result = socks_probe(&host, &workspace, shell, spelling, port);
        assert_socks_refused(&result, spelling, Some(marker.as_str()));
    }
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn metadata_and_private_shorthand_literals_are_refused() {
    // 2852039166 is 169.254.169.254 (cloud metadata); 10.1 is 10.0.0.1.
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    for (spelling, port) in [("2852039166", 80u16), ("10.1", 80u16)] {
        let target = format!("{spelling}:{port}");
        let result = connect_probe(&host, &workspace, shell, &target);
        assert_connect_refused(&result, &target, None);
        assert!(
            output(&result).contains("public internet only"),
            "CONNECT {target} must be refused by the sidecar's address guard: {result}"
        );
        let result = socks_probe(&host, &workspace, shell, spelling, port);
        assert_socks_refused(&result, spelling, None);
    }
}

/// Asserts the hosts file maps `name` to `address`. The windows-sandbox CI job adds these
/// entries; without them a hostname test would prove nothing.
fn require_hosts_entry(name: &str, address: &str) {
    let path = system_root().join(r"System32\drivers\etc\hosts");
    let hosts = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path:?}: {error}"));
    let present = hosts.lines().any(|line| {
        let mut fields = line.split('#').next().unwrap_or_default().split_whitespace();
        fields.next() == Some(address) && fields.any(|field| field == name)
    });
    assert!(
        present,
        "{path:?} must map {name} to {address} for this test: add the line `{address} {name}` \
         (the windows-sandbox CI job does) and flush the DNS cache"
    );
}

#[test]
#[ignore = "requires the Windows sandbox bundle, an installed sandbox and hosts-file test entries"]
fn hostnames_resolving_to_private_addresses_are_refused() {
    require_hosts_entry("sw-loop.test", "127.0.0.1");
    require_hosts_entry("sw-private.test", "10.0.0.1");
    let shell = active_shell();
    let (port, marker) = host_only_listener();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    for (name, port) in [("sw-loop.test", port), ("sw-private.test", 80)] {
        let target = format!("{name}:{port}");
        let result = connect_probe(&host, &workspace, shell, &target);
        assert_connect_refused(&result, &target, Some(marker.as_str()));
        let result = socks_probe(&host, &workspace, shell, name, port);
        assert_socks_refused(&result, name, Some(marker.as_str()));
    }
}

#[test]
#[ignore = "requires the Windows sandbox bundle and an installed sandbox"]
fn poisoned_proxy_variables_never_reach_the_sandbox() {
    for name in ["HTTP_PROXY", "HTTPS_PROXY"] {
        let value = std::env::var(name).unwrap_or_default();
        assert!(
            value.contains("127.0.0.1:9"),
            "this test proves nothing unless the job poisons %{name}% with http://127.0.0.1:9 \
             (the windows-sandbox job does); it is {value:?}"
        );
    }
    let shell = active_shell();
    let (_app, host) = host_with_bundle();
    let workspace = new_workspace(&host, "thread");
    let (result, env) = env_probe(&host, "poison", &workspace, shell);
    for key in ["httpsProxy", "httpProxy", "allProxy"] {
        let value = env[key].as_str().unwrap_or_default();
        assert!(
            !value.contains("127.0.0.1:9") && !value.ends_with(":9"),
            "the test process's poisoned proxy reached the sandbox in {key}: {value}"
        );
        let port: u16 = value
            .rsplit(':')
            .next()
            .and_then(|tail| tail.trim_end_matches('/').parse().ok())
            .unwrap_or(0);
        assert!(
            (60180..=60189).contains(&port) && value.contains("localhost"),
            "{key} must be the sandbox's own proxy on a port of 60180-60189, got {value:?} ({result})"
        );
    }
}
