//! Windows-specific host facts that are not about a shell or a path layout.
//!
//! This module is the home of the Windows sandbox setup (Plan 6, Task 7): the elevated install,
//! the verification of the staged helper and its readiness classification. Task 6 declares only
//! what command execution needs from it: where the staged `srt-win.exe` lives.
#![cfg_attr(not(windows), allow(dead_code))]
use std::path::PathBuf;

/// The one place the setup stages `srt-win.exe`: under the machine-wide `Program Files`, where
/// `Users` can read and execute it (the sandbox account runs it as the second hop of the launch)
/// but only an administrator can write it. The copy in the user-writable app-data bundle is never
/// what runs elevated or as the sandbox account.
const STAGED_SRT_WIN: &str = "SourceWeft\\sandbox\\srt-win.exe";

/// `%ProgramFiles%\SourceWeft\sandbox\srt-win.exe` from the given `ProgramW6432` and `ProgramFiles`
/// values. `ProgramW6432` (the 64-bit Program Files, also for a 32-bit process) wins; a value that
/// is not a drive-absolute directory is skipped rather than repaired, and `None` means the staged
/// path cannot be determined (the caller fails closed).
pub(crate) fn staged_srt_win_path_from(
    program_w6432: Option<&str>,
    program_files: Option<&str>,
) -> Option<PathBuf> {
    [program_w6432, program_files]
        .into_iter()
        .flatten()
        .find_map(|root| {
            let bytes = root.as_bytes();
            let drive = bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'\\' || bytes[2] == b'/');
            let trimmed = root.trim_end_matches(['\\', '/']);
            (drive && trimmed.len() > 2 && !root.chars().any(char::is_control))
                .then(|| PathBuf::from(format!("{}\\{STAGED_SRT_WIN}", trimmed.replace('/', "\\"))))
        })
}

/// [`staged_srt_win_path_from`] for this process's environment.
pub(crate) fn staged_srt_win_path() -> Option<PathBuf> {
    staged_srt_win_path_from(
        std::env::var("ProgramW6432").ok().as_deref(),
        std::env::var("ProgramFiles").ok().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_staged_helper_lives_under_the_64_bit_program_files() {
        assert_eq!(
            staged_srt_win_path_from(Some(r"C:\Program Files"), Some(r"C:\Program Files (x86)")),
            Some(PathBuf::from(
                r"C:\Program Files\SourceWeft\sandbox\srt-win.exe"
            ))
        );
    }

    #[test]
    fn program_files_is_used_when_program_w6432_is_absent_or_unusable() {
        let expected = Some(PathBuf::from(r"D:\Programs\SourceWeft\sandbox\srt-win.exe"));
        assert_eq!(
            staged_srt_win_path_from(None, Some(r"D:\Programs")),
            expected
        );
        assert_eq!(
            staged_srt_win_path_from(Some(""), Some(r"D:\Programs")),
            expected
        );
        assert_eq!(
            staged_srt_win_path_from(Some("relative"), Some("D:/Programs/")),
            expected
        );
    }

    #[test]
    fn nothing_usable_means_no_path() {
        assert_eq!(staged_srt_win_path_from(None, None), None);
        for bad in [
            "",
            "relative",
            r"\\server\share",
            "C:",
            r"C:\",
            "C:rel",
            "C:\\x\n",
        ] {
            assert_eq!(
                staged_srt_win_path_from(Some(bad), Some(bad)),
                None,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_result_is_a_native_absolute_drive_path() {
        let path = staged_srt_win_path_from(Some("c:/Program Files//"), None).unwrap();
        assert_eq!(
            path,
            Path::new(r"c:\Program Files\SourceWeft\sandbox\srt-win.exe")
        );
    }
}
