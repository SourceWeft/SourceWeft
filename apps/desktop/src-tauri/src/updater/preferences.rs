use super::policy::{Channel, Result};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub schema_version: u32,
    pub channel: Channel,
    pub auto_check: bool,
    pub auto_download: bool,
    pub snoozed_candidate: Option<String>,
    pub snoozed_until: u64,
    pub expected_version: Option<String>,
}
impl Preferences {
    pub fn load(path: &Path, version: &semver::Version) -> Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let value: Self = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("UPDATE_PREFERENCES_INVALID: {e}"))?;
                if value.schema_version != 1 {
                    return Err("UPDATE_PREFERENCES_SCHEMA_UNSUPPORTED".into());
                }
                Ok(value)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let value = Self {
                    schema_version: 1,
                    channel: Channel::initial(version),
                    auto_check: true,
                    auto_download: true,
                    snoozed_candidate: None,
                    snoozed_until: 0,
                    expected_version: None,
                };
                value.save(path)?;
                Ok(value)
            }
            Err(e) => Err(format!("UPDATE_PREFERENCES_READ_FAILED: {e}")),
        }
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        let write = || -> std::result::Result<(), Box<dyn std::error::Error>> {
            let dir = path.parent().ok_or("Missing preferences directory")?;
            std::fs::create_dir_all(dir)?;
            let mut file = tempfile::NamedTempFile::new_in(dir)?;
            file.write_all(&serde_json::to_vec_pretty(self)?)?;
            file.as_file().sync_all()?;
            file.persist(path)?;
            Ok(())
        };
        write().map_err(|e| format!("UPDATE_PREFERENCES_WRITE_FAILED: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_stable_choice_survives_rc_install_and_other_profiles_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("user-a.json");
        let mut prefs = Preferences::load(&path, &"0.2.0-rc.3".parse().unwrap()).unwrap();
        prefs.channel = Channel::Stable;
        prefs.auto_download = false;
        prefs.save(&path).unwrap();
        let loaded = Preferences::load(&path, &"0.3.0-rc.1".parse().unwrap()).unwrap();
        assert_eq!(loaded.channel, Channel::Stable);
        assert!(!loaded.auto_download);
        assert_eq!(
            Preferences::load(
                &dir.path().join("user-b.json"),
                &"0.3.0-rc.1".parse().unwrap()
            )
            .unwrap()
            .channel,
            Channel::Preview
        );
    }
    #[test]
    fn failed_atomic_replace_preserves_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        let prefs = Preferences::load(&path, &"0.2.0".parse().unwrap()).unwrap();
        let destination = dir.path().join("blocked");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("preserved"), "important").unwrap();
        assert!(prefs.save(&destination).is_err());
        assert_eq!(
            std::fs::read_to_string(destination.join("preserved")).unwrap(),
            "important"
        );
    }
    #[test]
    fn persists_rc_choice_through_stable_and_rejects_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        assert_eq!(
            Preferences::load(&path, &"0.2.0-rc.3".parse().unwrap())
                .unwrap()
                .channel,
            Channel::Preview
        );
        assert_eq!(
            Preferences::load(&path, &"0.2.0".parse().unwrap())
                .unwrap()
                .channel,
            Channel::Preview
        );
        std::fs::write(&path, "broken").unwrap();
        assert!(Preferences::load(&path, &"0.2.0".parse().unwrap()).is_err());
    }
}
