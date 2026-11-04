//! The shell a Windows sandboxed command runs under, and the environment prelude it starts with.
//!
//! # Which shell (Plan 6, W4)
//!
//! Git Bash (`bash.exe` from one of four fixed Git for Windows locations) when installed,
//! otherwise Windows PowerShell 5.1 at `%SystemRoot%\System32\WindowsPowerShell\v1.0`. Never
//! `cmd`, never `pwsh`, and never a `PATH` lookup: a shell found by searching `PATH` would let any
//! writable `PATH` entry choose the program that runs as the sandbox account's shell. When neither
//! exists the host has no shell and every caller fails closed.
//!
//! # Why a prelude (W8)
//!
//! The sandboxed child starts with the *sandbox account's own* profile environment plus an overlay
//! of the broker's `PATH`/`PATHEXT` and the proxy variables. Nothing else the host sets reaches
//! it. `HOME`, `TEMP`, `TMP` and the package-manager caches are therefore pinned by statements at
//! the start of the command string itself, quoted for the chosen shell. The values are workspace
//! paths chosen by the user, so the quoting is security relevant: every value is wrapped in a
//! single-quoted literal in which nothing is interpreted, and values that cannot appear in a path
//! (control characters) are refused instead of escaped.
//!
//! Everything here except [`detect`] is a pure function of its inputs, so it is tested on every
//! platform.
#![cfg_attr(not(windows), allow(dead_code))]
use super::{HostError, Result};
use std::path::{Path, PathBuf};

/// Which shell runs the command; the kind picks the prelude syntax and the name reported in the
/// device status and the runtime prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    GitBash,
    PowerShell,
}

impl ShellKind {
    /// The name reported to the backend (`^[a-zA-Z0-9._-]{1,64}$`): `bash` or `powershell`.
    pub const fn name(self) -> &'static str {
        match self {
            Self::GitBash => "bash",
            Self::PowerShell => "powershell",
        }
    }
}

/// The detected shell: its kind and the absolute path of its executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsShell {
    pub kind: ShellKind,
    pub exe: PathBuf,
}

impl WindowsShell {
    /// The install root that holds the shell's own files. Git Bash needs its whole Git
    /// installation (`usr\bin`, `mingw64`, `etc`), which sits two levels above `bin\bash.exe`;
    /// when that root is inside the user's profile it is a read root. Windows PowerShell lives in
    /// the system directory, readable by every account, and has none.
    pub fn install_root(&self) -> Option<PathBuf> {
        match self.kind {
            // String arithmetic on the spelled path, so it behaves the same on every host OS:
            // drop `bash.exe`, then `bin`.
            ShellKind::GitBash => {
                let text = self.exe.to_str()?;
                let (bin, _) = text.rsplit_once('\\')?;
                let (root, _) = bin.rsplit_once('\\')?;
                (!root.is_empty()).then(|| PathBuf::from(root))
            }
            ShellKind::PowerShell => None,
        }
    }
}

/// The environment values shell detection reads, owned so a test can supply any combination.
#[derive(Debug, Clone, Default)]
pub struct ShellRoots {
    pub program_files: Option<String>,
    pub program_w6432: Option<String>,
    pub program_files_x86: Option<String>,
    pub local_app_data: Option<String>,
    pub system_root: Option<String>,
}

impl ShellRoots {
    /// From Windows itself (the shell known-folder API and `GetWindowsDirectoryW`), never from
    /// environment variables: a process of the same user can set those for the app, and they
    /// choose which `bash.exe` and which PowerShell the sandboxed commands run under. Off Windows
    /// there are no roots (and no shell).
    pub fn from_env() -> Self {
        #[cfg(windows)]
        {
            use super::windows::{system_folder, windows_dir, SystemFolder};
            Self {
                program_files: system_folder(SystemFolder::ProgramFiles),
                program_w6432: system_folder(SystemFolder::ProgramFilesX64),
                program_files_x86: system_folder(SystemFolder::ProgramFilesX86),
                local_app_data: system_folder(SystemFolder::LocalAppData),
                system_root: windows_dir(),
            }
        }
        #[cfg(not(windows))]
        {
            Self::default()
        }
    }
}

/// `root` as a drive-absolute directory spelling without a trailing separator, or `None` for
/// anything else (empty, relative, UNC, drive-relative): a malformed environment value is skipped,
/// never guessed at.
fn drive_root(root: &str) -> Option<String> {
    let bytes = root.as_bytes();
    let ok = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    if !ok || root.chars().any(char::is_control) {
        return None;
    }
    let trimmed = root.trim_end_matches(['\\', '/']);
    // `C:\` trims to `C:`; a drive root is not an install location.
    (trimmed.len() > 2).then(|| trimmed.replace('/', "\\"))
}

/// The Git Bash candidates in precedence order, de-duplicated (on a 64-bit machine `ProgramFiles`
/// and `ProgramW6432` name the same directory).
fn git_bash_candidates(roots: &ShellRoots) -> Vec<PathBuf> {
    let mut seen: Vec<String> = Vec::new();
    let mut candidates = Vec::new();
    let locations = [
        (&roots.program_files, "Git\\bin\\bash.exe"),
        (&roots.program_w6432, "Git\\bin\\bash.exe"),
        (&roots.program_files_x86, "Git\\bin\\bash.exe"),
        (&roots.local_app_data, "Programs\\Git\\bin\\bash.exe"),
    ];
    for (root, tail) in locations {
        let Some(root) = root.as_deref().and_then(drive_root) else {
            continue;
        };
        let full = format!("{root}\\{tail}");
        let key = full.to_ascii_lowercase();
        if !seen.contains(&key) {
            seen.push(key);
            candidates.push(PathBuf::from(full));
        }
    }
    candidates
}

/// Windows PowerShell 5.1 under the system directory, or `None` when `SystemRoot` is unusable.
fn powershell_path(roots: &ShellRoots) -> Option<PathBuf> {
    let root = roots.system_root.as_deref().and_then(drive_root)?;
    Some(PathBuf::from(format!(
        "{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    )))
}

/// The shell to use given the environment roots and a predicate for "this file exists": the first
/// existing Git Bash candidate, else PowerShell 5.1, else `None` (the caller fails closed).
pub fn detect_with(roots: &ShellRoots, exists: impl Fn(&Path) -> bool) -> Option<WindowsShell> {
    if let Some(exe) = git_bash_candidates(roots)
        .into_iter()
        .find(|candidate| exists(candidate))
    {
        return Some(WindowsShell {
            kind: ShellKind::GitBash,
            exe,
        });
    }
    let exe = powershell_path(roots)?;
    exists(&exe).then_some(WindowsShell {
        kind: ShellKind::PowerShell,
        exe,
    })
}

/// [`detect_with`] against this machine's environment and file system.
pub fn detect() -> Option<WindowsShell> {
    detect_with(&ShellRoots::from_env(), |path| path.is_file())
}

/// The error for a host with no usable shell.
pub fn no_shell_error() -> HostError {
    HostError::new(
        "SANDBOX_UNAVAILABLE",
        "No supported shell was found. Install Git for Windows, or use Windows PowerShell 5.1 \
         (%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe), to run local commands.",
    )
}

/// Refuses values no real path contains. A newline would end a prelude statement inside a
/// quoted literal's neighbourhood only if quoting were wrong, but there is nothing to gain by
/// accepting it: reject so a quoting mistake could never be the thing standing between a hostile
/// folder name and a second statement.
fn check_value(value: &str) -> Result<()> {
    if value.is_empty() || value.chars().any(|c| c.is_control()) {
        return Err(HostError::new(
            "INVALID_PATH",
            "The workspace path contains characters that cannot be placed in a shell command.",
        ));
    }
    Ok(())
}

/// POSIX single-quote quoting for Git Bash: `'` ... `'`, each embedded `'` as `'\''`. Inside
/// single quotes bash interprets nothing (no `$`, backtick, `\`, `!`, `*`, `[`, `~`).
pub fn quote_bash(value: &str) -> Result<String> {
    check_value(value)?;
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

/// The characters Windows PowerShell's tokenizer treats as a single quote: the ASCII apostrophe
/// and the four typographic ones (U+2018, U+2019, U+201A, U+201B). Inside a single-quoted literal
/// any of them followed by any of them stands for one quote character, and a lone one ends the
/// literal — so a folder named `it’s` would otherwise terminate the string.
const POWERSHELL_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// PowerShell single-quoted literal: every quote-like character is doubled, nothing else is
/// interpreted (no `$`, backtick, `[`, `%`, `&`, `;`).
pub fn quote_powershell(value: &str) -> Result<String> {
    check_value(value)?;
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for c in value.chars() {
        quoted.push(c);
        if POWERSHELL_QUOTES.contains(&c) {
            quoted.push(c);
        }
    }
    quoted.push('\'');
    Ok(quoted)
}

/// The pinned environment as `(name, value)` pairs for a workspace whose root is `root` (wire
/// form, `C:/...`). Everything lives under the workspace, the only place the sandbox may write.
fn pinned_variables(root: &str) -> [(&'static str, String); 5] {
    let root = root.trim_end_matches('/');
    [
        ("HOME", root.to_string()),
        ("TEMP", format!("{root}/.tmp")),
        ("TMP", format!("{root}/.tmp")),
        ("npm_config_cache", format!("{root}/.cache/npm")),
        ("PIP_CACHE_DIR", format!("{root}/.cache/pip")),
    ]
}

/// The statements that pin `HOME`, `TEMP`, `TMP`, `npm_config_cache` and `PIP_CACHE_DIR` for a
/// workspace rooted at `root` (wire form), one per line and newline-terminated, in the syntax of
/// `kind`. Fails for a value that cannot be quoted safely.
pub fn prelude(kind: ShellKind, root: &str) -> Result<String> {
    let mut text = String::new();
    for (name, value) in pinned_variables(root) {
        match kind {
            ShellKind::GitBash => {
                text.push_str(&format!("export {name}={}\n", quote_bash(&value)?));
            }
            ShellKind::PowerShell => {
                text.push_str(&format!("$env:{name} = {}\n", quote_powershell(&value)?));
            }
        }
    }
    Ok(text)
}

/// The statement that makes the command start in `cwd` (wire form), or nothing for bash.
///
/// Windows PowerShell initialises its location from the process's current directory through the
/// FileSystem provider, which treats `[` and `]` as wildcard characters: for a workspace such as
/// `C:\Users\me\[work]` it fails to resolve the path and silently falls back to its own
/// directory (`C:\Windows\System32\WindowsPowerShell\v1.0`), so the command would run in the wrong
/// place. `Set-Location -LiteralPath` takes the path verbatim. A failure must stop the command
/// instead of running it elsewhere: `-ErrorAction Stop` ends the script with a non-zero exit code
/// and the `$?` check covers any non-terminating path. Git Bash keeps the directory it was started
/// in, so it gets no statement.
fn cwd_statement(kind: ShellKind, cwd: &str) -> Result<String> {
    match kind {
        ShellKind::GitBash => Ok(String::new()),
        ShellKind::PowerShell => Ok(format!(
            "Set-Location -LiteralPath {} -ErrorAction Stop; if (-not $?) {{ exit 1 }}\n",
            quote_powershell(cwd)?
        )),
    }
}

/// [`prelude`] preceded, for PowerShell, by the statement that enters `cwd` (wire form; see
/// `cwd_statement`). The directory change is the FIRST statement, so nothing else runs, and no
/// variable is pinned, in the wrong directory.
pub fn prelude_in(kind: ShellKind, root: &str, cwd: &str) -> Result<String> {
    Ok(format!(
        "{}{}",
        cwd_statement(kind, cwd)?,
        prelude(kind, root)?
    ))
}

/// `script` with the prelude in front. A newline-separated prefix leaves any valid script
/// unchanged. `root` is the native workspace root and `cwd` the native directory inside it the
/// command starts in; the prelude carries their wire forms (`C:/...`), which both shells accept.
pub fn pinned_script(kind: ShellKind, root: &Path, cwd: &Path, script: &str) -> Result<String> {
    let root = super::winpath::to_wire(root)?;
    let cwd = super::winpath::to_wire(cwd)?;
    Ok(format!("{}{script}", prelude_in(kind, &root, &cwd)?))
}

/// Creates `<root>/.tmp` (one level) so `TEMP` exists before the command runs, and refuses a
/// `.tmp` that is not a plain directory: a link there would point `TEMP` somewhere else.
pub fn prepare_tmpdir(root: &Path) -> Result<()> {
    let tmp = root.join(".tmp");
    match std::fs::create_dir(&tmp) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = tmp.symlink_metadata()?;
    #[cfg(windows)]
    let linked = super::winpath::is_reparse_point(&metadata);
    #[cfg(not(windows))]
    let linked = false;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || linked {
        return Err(HostError::new(
            "TMPDIR_INVALID",
            "The workspace's .tmp entry is not a plain folder, so it cannot be the temp directory.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(pairs: &[(&str, &str)]) -> ShellRoots {
        let mut roots = ShellRoots::default();
        for (name, value) in pairs {
            let slot = match *name {
                "ProgramFiles" => &mut roots.program_files,
                "ProgramW6432" => &mut roots.program_w6432,
                "ProgramFiles(x86)" => &mut roots.program_files_x86,
                "LOCALAPPDATA" => &mut roots.local_app_data,
                "SystemRoot" => &mut roots.system_root,
                other => panic!("{other}"),
            };
            *slot = Some(value.to_string());
        }
        roots
    }

    fn present<'a>(files: &'a [&'a str]) -> impl Fn(&Path) -> bool + 'a {
        move |path| {
            files
                .iter()
                .any(|file| path.to_str().is_some_and(|p| p.eq_ignore_ascii_case(file)))
        }
    }

    const POWERSHELL: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

    #[test]
    fn git_bash_wins_over_powershell_and_the_locations_are_fixed() {
        let env = roots(&[
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramW6432", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ("LOCALAPPDATA", r"C:\Users\me\AppData\Local"),
            ("SystemRoot", r"C:\Windows"),
        ]);
        let all = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
            r"C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe",
            POWERSHELL,
        ];
        let shell = detect_with(&env, present(&all)).unwrap();
        assert_eq!(shell.kind, ShellKind::GitBash);
        assert_eq!(shell.exe, Path::new(r"C:\Program Files\Git\bin\bash.exe"));

        // Without the 64-bit one the 32-bit install is next, then the per-user one.
        let shell = detect_with(&env, present(&all[1..])).unwrap();
        assert_eq!(
            shell.exe,
            Path::new(r"C:\Program Files (x86)\Git\bin\bash.exe")
        );
        let shell = detect_with(&env, present(&all[2..])).unwrap();
        assert_eq!(
            shell.exe,
            Path::new(r"C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe")
        );
        // Only PowerShell left.
        let shell = detect_with(&env, present(&all[3..])).unwrap();
        assert_eq!(shell.kind, ShellKind::PowerShell);
        assert_eq!(shell.exe, Path::new(POWERSHELL));
    }

    #[test]
    fn no_shell_when_neither_exists_or_system_root_is_unusable() {
        let env = roots(&[
            ("ProgramFiles", r"C:\Program Files"),
            ("SystemRoot", r"C:\Windows"),
        ]);
        assert_eq!(detect_with(&env, |_| false), None);
        // PowerShell is derived from SystemRoot only: no root, no shell, even if the file exists.
        let env = roots(&[("ProgramFiles", r"C:\Program Files")]);
        assert_eq!(
            detect_with(&env, |_| true).map(|s| s.kind),
            Some(ShellKind::GitBash)
        );
        let env = ShellRoots::default();
        assert_eq!(detect_with(&env, |_| true), None);
    }

    #[test]
    fn only_the_fixed_locations_are_ever_probed() {
        let env = roots(&[
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramW6432", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ("LOCALAPPDATA", r"C:\Users\me\AppData\Local"),
            ("SystemRoot", r"C:\Windows"),
        ]);
        let probed = std::cell::RefCell::new(Vec::new());
        assert_eq!(
            detect_with(&env, |path| {
                probed.borrow_mut().push(path.to_str().unwrap().to_string());
                false
            }),
            None
        );
        // ProgramFiles and ProgramW6432 name the same directory: probed once.
        assert_eq!(
            probed.into_inner(),
            [
                r"C:\Program Files\Git\bin\bash.exe",
                r"C:\Program Files (x86)\Git\bin\bash.exe",
                r"C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe",
                POWERSHELL,
            ]
        );
    }

    #[test]
    fn malformed_environment_values_are_skipped_not_repaired() {
        for bad in [
            "",
            "relative\\dir",
            r"\\server\share",
            "C:",
            r"C:\",
            "C:rel",
            "D\u{0}:\\x",
        ] {
            let env = roots(&[
                ("ProgramFiles", bad),
                ("LOCALAPPDATA", bad),
                ("SystemRoot", bad),
            ]);
            assert_eq!(detect_with(&env, |_| true), None, "{bad:?}");
        }
        // Forward slashes and a trailing separator are normalised.
        let env = roots(&[("ProgramFiles", "C:/Program Files/")]);
        let shell = detect_with(&env, |_| true).unwrap();
        assert_eq!(shell.exe, Path::new(r"C:\Program Files\Git\bin\bash.exe"));
    }

    #[test]
    fn the_names_are_the_backend_vocabulary() {
        assert_eq!(ShellKind::GitBash.name(), "bash");
        assert_eq!(ShellKind::PowerShell.name(), "powershell");
    }

    #[test]
    fn git_bash_has_an_install_root_and_powershell_has_none() {
        let bash = WindowsShell {
            kind: ShellKind::GitBash,
            exe: PathBuf::from(r"C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe"),
        };
        assert_eq!(
            bash.install_root().unwrap(),
            Path::new(r"C:\Users\me\AppData\Local\Programs\Git")
        );
        let powershell = WindowsShell {
            kind: ShellKind::PowerShell,
            exe: PathBuf::from(POWERSHELL),
        };
        assert_eq!(powershell.install_root(), None);
    }

    /// The values the quoting must survive: spaces, quotes of every kind, CJK, glob and regex
    /// metacharacters, expansion triggers, percent signs and statement separators.
    fn nasty_values() -> Vec<String> {
        let mut values: Vec<String> = [
            "C:/Users/me/My Project",
            "C:/Users/o'brien/work",
            "C:/Users/it's/'quoted'/work",
            "''''",
            "'",
            "C:/ws/\u{2019}smart\u{2019}",
            "C:/ws/\u{2018}\u{201A}\u{201B}\u{2019}'",
            "C:/ws/\u{2019}'; Remove-Item -Recurse C:/ #",
            "C:/项目/测试 文件",
            "C:/ws/[brackets] and [a-z]*?",
            "C:/ws/$HOME/$(whoami)/${PATH}/$env:USERPROFILE",
            "C:/ws/`backtick`/`n/`$x",
            "C:/ws/100%/%PATH%/%USERPROFILE%",
            "C:/ws/a&b;c|d>e<f(g)h{i}",
            "C:/ws/a&&b||c; rm -rf /",
            "C:/ws/\"double\" quotes",
            "C:/ws/back\\slash\\",
            "C:/ws/!history !!/~/tilde",
            "C:/ws/#hash # comment",
            "'; rm -rf / #",
            "' ; Write-Host pwned ; '",
            "C:/ws/\u{1F600}/emoji",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // Every printable ASCII character alone and in a sandwich.
        for c in (0x20u8..0x7f).map(char::from) {
            values.push(format!("{c}"));
            values.push(format!("a{c}b{c}{c}c"));
            values.push(format!("{c}{c}{c}"));
        }
        values
    }

    /// POSIX single-quote reading, independent of the quoting code: a word made of `'...'`
    /// segments and `\'` escapes. Returns `None` for anything else — including an unquoted
    /// character, which is exactly what an injection would look like.
    fn read_posix_word(word: &str) -> Option<String> {
        let mut out = String::new();
        let mut chars = word.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\'' => loop {
                    match chars.next()? {
                        '\'' => break,
                        other => out.push(other),
                    }
                },
                '\\' if chars.peek() == Some(&'\'') => {
                    chars.next();
                    out.push('\'');
                }
                _ => return None,
            }
        }
        Some(out)
    }

    /// Windows PowerShell's single-quoted string reading, from its tokenizer: after an opening
    /// quote-like character, a quote-like character followed by another ends the literal only
    /// when it is not followed by another quote-like character; a pair contributes the second
    /// character. Returns `(value, rest)`, `None` when the literal never ends.
    fn read_powershell_literal(text: &str) -> Option<(String, &str)> {
        let mut chars = text.char_indices();
        let (_, first) = chars.next()?;
        if !POWERSHELL_QUOTES.contains(&first) {
            return None;
        }
        let mut value = String::new();
        let mut rest = chars.clone().peekable();
        while let Some((index, c)) = rest.next() {
            if POWERSHELL_QUOTES.contains(&c) {
                match rest.peek() {
                    Some(&(_, next)) if POWERSHELL_QUOTES.contains(&next) => {
                        rest.next();
                        value.push(next);
                    }
                    _ => return Some((value, &text[index + c.len_utf8()..])),
                }
            } else {
                value.push(c);
            }
        }
        None
    }

    #[test]
    fn bash_quoting_round_trips_and_never_leaves_a_character_unquoted() {
        for value in nasty_values() {
            let quoted = quote_bash(&value).unwrap();
            assert_eq!(
                read_posix_word(&quoted).as_deref(),
                Some(value.as_str()),
                "{value:?} -> {quoted}"
            );
        }
    }

    #[test]
    fn powershell_quoting_round_trips_and_ends_exactly_at_the_closing_quote() {
        for value in nasty_values() {
            let quoted = quote_powershell(&value).unwrap();
            // A statement terminator after the literal must not be swallowed or misread.
            let line = format!("{quoted}\n");
            let (read, rest) = read_powershell_literal(&line).unwrap_or_else(|| {
                panic!("{value:?} -> {quoted} never terminates");
            });
            assert_eq!(read, value, "{quoted}");
            assert_eq!(
                rest, "\n",
                "{value:?} -> {quoted} leaked into the statement"
            );
        }
    }

    #[test]
    fn powershell_typographic_quotes_cannot_end_the_literal() {
        // The classic injection: a smart quote closes a naively ASCII-doubled literal.
        let hostile = "C:/ws/x\u{2019}; Remove-Item C:/ -Recurse; \u{2019}";
        let quoted = quote_powershell(hostile).unwrap();
        let line = format!("{quoted}\n");
        let (read, rest) = read_powershell_literal(&line).unwrap();
        assert_eq!(read, hostile);
        assert_eq!(rest, "\n");
        // Naive ASCII-only doubling would not survive this reader: proves the reader is strict.
        let naive = format!("'{}'", hostile.replace('\'', "''"));
        let naive_line = format!("{naive}\n");
        let (naive_read, naive_rest) = read_powershell_literal(&naive_line).unwrap();
        assert_ne!((naive_read.as_str(), naive_rest), (hostile, "\n"));
    }

    #[test]
    fn control_characters_and_empty_values_are_refused() {
        for bad in [
            "",
            "a\nb",
            "a\rb",
            "a\u{0}b",
            "a\tb",
            "a\u{1b}[31m",
            "\u{7f}",
            "x\u{85}y",
        ] {
            assert!(quote_bash(bad).is_err(), "{bad:?}");
            assert!(quote_powershell(bad).is_err(), "{bad:?}");
            assert!(prelude(ShellKind::GitBash, bad).is_err(), "{bad:?}");
            assert!(prelude(ShellKind::PowerShell, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_bash_prelude_pins_the_five_variables_one_statement_per_line() {
        let text = prelude(ShellKind::GitBash, "C:/Users/o'brien/My Work").unwrap();
        assert_eq!(
            text,
            "export HOME='C:/Users/o'\\''brien/My Work'\n\
             export TEMP='C:/Users/o'\\''brien/My Work/.tmp'\n\
             export TMP='C:/Users/o'\\''brien/My Work/.tmp'\n\
             export npm_config_cache='C:/Users/o'\\''brien/My Work/.cache/npm'\n\
             export PIP_CACHE_DIR='C:/Users/o'\\''brien/My Work/.cache/pip'\n"
        );
    }

    #[test]
    fn the_powershell_prelude_pins_the_five_variables_one_statement_per_line() {
        let text = prelude(ShellKind::PowerShell, "C:/Users/o'brien/[测试] $x").unwrap();
        assert_eq!(
            text,
            "$env:HOME = 'C:/Users/o''brien/[测试] $x'\n\
             $env:TEMP = 'C:/Users/o''brien/[测试] $x/.tmp'\n\
             $env:TMP = 'C:/Users/o''brien/[测试] $x/.tmp'\n\
             $env:npm_config_cache = 'C:/Users/o''brien/[测试] $x/.cache/npm'\n\
             $env:PIP_CACHE_DIR = 'C:/Users/o''brien/[测试] $x/.cache/pip'\n"
        );
    }

    #[test]
    fn a_trailing_slash_on_the_root_is_not_doubled() {
        let text = prelude(ShellKind::GitBash, "C:/ws/").unwrap();
        assert!(text.contains("export TEMP='C:/ws/.tmp'\n"), "{text}");
    }

    #[test]
    fn every_prelude_line_is_exactly_one_assignment_for_every_nasty_root() {
        // A root of only slashes trims to nothing and is refused (covered by the empty-value test).
        for value in nasty_values()
            .into_iter()
            .filter(|v| !v.chars().any(char::is_control) && !v.chars().all(|c| c == '/'))
        {
            let bash = prelude(ShellKind::GitBash, &value).unwrap();
            assert_eq!(bash.matches('\n').count(), 5, "{value:?}");
            for line in bash.lines() {
                let (head, word) = line.split_once('=').unwrap();
                assert!(head.starts_with("export "), "{line}");
                assert!(read_posix_word(word).is_some(), "{value:?}: {line}");
            }
            let powershell = prelude(ShellKind::PowerShell, &value).unwrap();
            assert_eq!(powershell.matches('\n').count(), 5, "{value:?}");
            for line in powershell.lines() {
                let (head, word) = line.split_once(" = ").unwrap();
                assert!(head.starts_with("$env:"), "{line}");
                let statement = format!("{word}\n");
                let (_, rest) = read_powershell_literal(&statement).unwrap();
                assert_eq!(rest, "\n", "{value:?}: {line}");
            }
        }
    }

    #[test]
    fn pinned_script_keeps_the_user_script_byte_for_byte_after_the_prelude() {
        let script = "echo 'hi'\r\nls | wc -l\n";
        let root = Path::new(r"C:\Users\me\My Work");
        for kind in [ShellKind::GitBash, ShellKind::PowerShell] {
            let pinned = pinned_script(kind, root, root, script).unwrap();
            assert!(pinned.ends_with(&format!("\n{script}")), "{pinned}");
            assert!(pinned.contains("C:/Users/me/My Work"), "{pinned}");
            assert!(
                !pinned.contains('\\') || script.contains('\\'),
                "wire form only: {pinned}"
            );
        }
        // A root or cwd that cannot be spelled on the wire is an error, not a guess.
        let ok = Path::new(r"C:\ws");
        assert!(pinned_script(ShellKind::GitBash, Path::new("relative"), ok, "x").is_err());
        assert!(pinned_script(ShellKind::PowerShell, ok, Path::new("relative"), "x").is_err());
    }

    #[test]
    fn powershell_enters_the_cwd_literally_as_its_first_statement_and_bash_is_unchanged() {
        let root = Path::new(r"C:\Users\me\[work] it's");
        let cwd = Path::new(r"C:\Users\me\[work] it's\src\[a]");
        let powershell = pinned_script(ShellKind::PowerShell, root, cwd, "node x.js").unwrap();
        assert_eq!(
            powershell.lines().next().unwrap(),
            "Set-Location -LiteralPath 'C:/Users/me/[work] it''s/src/[a]' -ErrorAction Stop; \
             if (-not $?) { exit 1 }"
        );
        // The pinned variables still follow, and the script is last.
        assert!(powershell.contains("$env:HOME = 'C:/Users/me/[work] it''s'\n"));
        assert!(powershell.ends_with("node x.js"));
        // Bash keeps the directory it was started in: the text is exactly the env prelude.
        let bash = pinned_script(ShellKind::GitBash, root, cwd, "node x.js").unwrap();
        assert_eq!(
            bash,
            format!(
                "{}node x.js",
                prelude(ShellKind::GitBash, "C:/Users/me/[work] it's").unwrap()
            )
        );
        assert!(!bash.contains("Set-Location") && !bash.contains("cd "));
    }

    #[test]
    fn the_cwd_statement_is_one_literal_for_every_nasty_cwd() {
        for value in nasty_values()
            .into_iter()
            .filter(|v| !v.chars().any(char::is_control))
        {
            let statement = cwd_statement(ShellKind::PowerShell, &value).unwrap();
            let literal = statement
                .strip_prefix("Set-Location -LiteralPath ")
                .unwrap();
            let (read, rest) = read_powershell_literal(literal).unwrap();
            assert_eq!(read, value);
            assert_eq!(
                rest, " -ErrorAction Stop; if (-not $?) { exit 1 }\n",
                "{value:?} leaked into the statement"
            );
            assert_eq!(statement.matches('\n').count(), 1);
            assert_eq!(cwd_statement(ShellKind::GitBash, &value).unwrap(), "");
        }
        for bad in ["", "a\nb", "a\u{0}b", "a\rb"] {
            assert!(
                cwd_statement(ShellKind::PowerShell, bad).is_err(),
                "{bad:?}"
            );
        }
        // The hostile shapes the coordinator named, spelled out.
        for cwd in [
            "C:/ws/[a]/b[1]",
            "C:/ws/it's",
            "C:/ws/\u{2019}x\u{2019}",
            "C:/项目/测试",
            "C:/ws/`n`$x",
            "C:/ws/$(calc)/$env:X",
            "C:/ws/100%/%PATH%",
            "C:/ws/a&b;c|d",
        ] {
            let statement = cwd_statement(ShellKind::PowerShell, cwd).unwrap();
            let literal = statement
                .strip_prefix("Set-Location -LiteralPath ")
                .unwrap();
            assert_eq!(read_powershell_literal(literal).unwrap().0, cwd);
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_bash_prelude_really_sets_the_variables_in_a_posix_shell() {
        // The quoting is plain POSIX single-quote quoting, so `/bin/sh` is a faithful stand-in
        // for what Git Bash does with it. Check the variables, never anything extra.
        let root = "C:/Users/o'brien/[测试] $(touch pwned) `id` 100% &;|<> My Work";
        let script = format!(
            "{}printf '%s\\n' \"$HOME\" \"$TEMP\" \"$TMP\" \"$npm_config_cache\" \"$PIP_CACHE_DIR\"",
            prelude(ShellKind::GitBash, root).unwrap()
        );
        let dir = tempfile::tempdir().unwrap();
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        let lines: Vec<String> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(
            lines,
            [
                root.to_string(),
                format!("{root}/.tmp"),
                format!("{root}/.tmp"),
                format!("{root}/.cache/npm"),
                format!("{root}/.cache/pip"),
            ]
        );
        assert!(!dir.path().join("pwned").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn prepare_tmpdir_creates_once_and_refuses_a_link() {
        let root = tempfile::tempdir().unwrap();
        prepare_tmpdir(root.path()).unwrap();
        assert!(root.path().join(".tmp").is_dir());
        prepare_tmpdir(root.path()).unwrap(); // idempotent
                                              // A file squatting on the name is not a temp directory.
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join(".tmp"), "x").unwrap();
        assert_eq!(
            prepare_tmpdir(other.path()).unwrap_err().code,
            "TMPDIR_INVALID"
        );
        #[cfg(unix)]
        {
            let linked = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(other.path(), linked.path().join(".tmp")).unwrap();
            assert_eq!(
                prepare_tmpdir(linked.path()).unwrap_err().code,
                "TMPDIR_INVALID"
            );
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    /// Runs `script` in the real Windows PowerShell 5.1 and returns its stdout. The script is
    /// passed as `-EncodedCommand` (UTF-16LE base64) so the command line itself needs no quoting.
    fn run_powershell(script: &str) -> String {
        let shell = detect_with(&ShellRoots::from_env(), |p| p.is_file()).unwrap();
        let exe = if shell.kind == ShellKind::PowerShell {
            shell.exe
        } else {
            let root = std::env::var("SystemRoot").unwrap();
            PathBuf::from(format!(
                r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"
            ))
        };
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let output = std::process::Command::new(exe)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &STANDARD.encode(utf16),
            ])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    #[test]
    fn the_powershell_prelude_really_sets_the_variables() {
        for root in [
            "C:/Users/o'brien/My Work",
            "C:/ws/\u{2019}smart\u{2018}/x",
            "C:/ws/[测试] $(calc) `n 100% &;|<>",
            "C:/ws/'; Write-Output pwned; '",
        ] {
            let script = format!(
                "{}$values = ($env:HOME, $env:TEMP, $env:TMP, $env:npm_config_cache, $env:PIP_CACHE_DIR) -join \"`n\"; \
                 [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($values)))",
                prelude(ShellKind::PowerShell, root).unwrap()
            );
            // Base64 of the UTF-8 text: the console code page cannot corrupt it.
            let out = String::from_utf8(STANDARD.decode(run_powershell(&script).trim()).unwrap())
                .unwrap();
            assert_eq!(
                out.split('\n').collect::<Vec<_>>(),
                [
                    root.to_string(),
                    format!("{root}/.tmp"),
                    format!("{root}/.tmp"),
                    format!("{root}/.cache/npm"),
                    format!("{root}/.cache/pip"),
                ],
                "{root:?}"
            );
        }
    }

    /// The regression behind `cwd_statement`: a start directory with `[ ]`, an apostrophe, a
    /// space and CJK must be the command's directory, not PowerShell's own.
    #[test]
    fn the_powershell_prelude_enters_a_bracketed_apostrophe_directory() {
        let tree = tempfile::tempdir().unwrap();
        let base = tree.path().canonicalize().unwrap();
        let dir = base.join("[a] it's 测试 b").join("sub[1]");
        std::fs::create_dir_all(&dir).unwrap();
        let native = crate::local_host::winpath::to_native(&dir).unwrap();
        let wire = crate::local_host::winpath::to_wire(&dir).unwrap();
        let root = crate::local_host::winpath::to_wire(dir.parent().unwrap()).unwrap();
        let script = format!(
            "{}$here = (Get-Location).ProviderPath; \
             [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($here)))",
            prelude_in(ShellKind::PowerShell, &root, &wire).unwrap()
        );
        let out =
            String::from_utf8(STANDARD.decode(run_powershell(&script).trim()).unwrap()).unwrap();
        assert_eq!(out, native.to_str().unwrap());
    }

    /// A start directory that cannot be entered stops the command before anything else runs.
    #[test]
    fn a_missing_cwd_stops_the_powershell_command() {
        let tree = tempfile::tempdir().unwrap();
        let gone = crate::local_host::winpath::to_wire(
            &tree.path().canonicalize().unwrap().join("[gone]"),
        )
        .unwrap();
        let marker = tree.path().join("ran.txt");
        let script = format!(
            "{}New-Item -ItemType File -Path '{}' | Out-Null",
            prelude_in(ShellKind::PowerShell, "C:/ws", &gone).unwrap(),
            marker.display()
        );
        let shell = detect_with(&ShellRoots::from_env(), |p| p.is_file()).unwrap();
        let exe = if shell.kind == ShellKind::PowerShell {
            shell.exe
        } else {
            let root = std::env::var("SystemRoot").unwrap();
            PathBuf::from(format!(
                r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"
            ))
        };
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let output = std::process::Command::new(exe)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &STANDARD.encode(utf16),
            ])
            .output()
            .unwrap();
        assert!(!output.status.success(), "{output:?}");
        assert!(
            !marker.exists(),
            "the command must not run in the wrong directory"
        );
    }

    #[test]
    fn detect_finds_a_shell_on_this_machine() {
        let shell = detect().expect("Windows PowerShell 5.1 ships with Windows");
        assert!(shell.exe.is_absolute() && shell.exe.is_file());
    }
}
