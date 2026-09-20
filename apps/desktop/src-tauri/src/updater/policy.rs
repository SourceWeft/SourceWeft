use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BASE_URL: &str = "https://download.sourceweft.com";
pub const MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const TARGETS: [&str; 4] = [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "linux-x86_64",
];
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Preview,
}
impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Preview => "preview",
        }
    }
    pub fn endpoint(self) -> String {
        format!("{BASE_URL}/updates/{}.json", self.name())
    }
    pub fn initial(version: &Version) -> Self {
        if version.pre.is_empty() {
            Self::Stable
        } else {
            Self::Preview
        }
    }
}

pub fn target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok(TARGETS[0]),
        ("macos", "x86_64") => Ok(TARGETS[1]),
        ("windows", "x86_64") => Ok(TARGETS[2]),
        ("linux", "x86_64") => Ok(TARGETS[3]),
        _ => Err("UNSUPPORTED_UPDATE_TARGET".into()),
    }
}

pub fn validate(value: &Value, channel: Channel) -> Result<Version> {
    let invalid = || "INVALID_UPDATE_MANIFEST".to_string();
    let parsed: tauri_plugin_updater::RemoteRelease =
        serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    if parsed.pub_date.is_none() {
        return Err(invalid());
    }
    let version =
        Version::parse(value["version"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
    if !version.build.is_empty() || (channel == Channel::Stable && !version.pre.is_empty()) {
        return Err(invalid());
    }
    let control = &value["sourceweft"];
    if control["schemaVersion"] != 1
        || !matches!(
            control["distribution"].as_str(),
            Some("active" | "paused" | "withdrawn")
        )
        || !control["revision"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
        || !control["reason"].as_str().is_some_and(|s| s.len() <= 8000)
        || !value["notes"].as_str().is_some_and(|s| s.len() <= 262144)
    {
        return Err(invalid());
    }
    let platforms = value["platforms"].as_object().ok_or_else(invalid)?;
    if platforms.len() != TARGETS.len() {
        return Err(invalid());
    }
    for target in TARGETS {
        let item = &value["platforms"][target];
        let url =
            url::Url::parse(item["url"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
        let prefix = format!("{BASE_URL}/releases/v{version}/");
        let extension = if target.starts_with("darwin-") {
            ".app.tar.gz"
        } else if target.starts_with("linux-") {
            ".AppImage"
        } else {
            ".exe"
        };
        if !url.as_str().starts_with(&prefix)
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().ends_with(extension)
            || !item["signature"].as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 8192
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
            })
        {
            return Err(invalid());
        }
    }
    Ok(version)
}

pub fn active(value: &Value) -> Result<()> {
    match value["sourceweft"]["distribution"].as_str() {
        Some("active") => Ok(()),
        Some("paused") => Err("DISTRIBUTION_PAUSED".into()),
        Some("withdrawn") => Err("UPDATE_WITHDRAWN".into()),
        _ => Err("INVALID_UPDATE_CONTROL".into()),
    }
}

pub fn identity(value: &Value, channel: Channel, target: &str) -> String {
    serde_json::json!([
        channel,
        value["version"],
        target,
        value["platforms"][target]
    ])
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn development_config_can_initialize_the_official_plugin_without_a_signing_key() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let parsed: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(parsed.pubkey.is_empty());
        assert!(!parsed.dangerous_accept_invalid_certs);
    }
    fn manifest(version: &str) -> Value {
        let mut platforms = serde_json::Map::new();
        for target in TARGETS {
            platforms.insert(target.into(), serde_json::json!({"url":format!("{BASE_URL}/releases/v{version}/{target}{}", if target.starts_with("darwin-") { ".app.tar.gz" } else if target.starts_with("linux-") { ".AppImage" } else { ".exe" }),"signature":"dGVzdA=="}));
        }
        serde_json::json!({"version":version,"pub_date":"2026-09-20T00:00:00Z","notes":"test","platforms":platforms,"sourceweft":{"schemaVersion":1,"distribution":"active","revision":1,"reason":""}})
    }
    #[test]
    fn versions_and_channels() {
        let versions = ["0.2.0-rc.3", "0.2.0-rc.10", "0.2.0", "0.2.1-rc.1"];
        for pair in versions.windows(2) {
            assert!(
                validate(&manifest(pair[0]), Channel::Preview).unwrap()
                    < validate(&manifest(pair[1]), Channel::Preview).unwrap()
            );
        }
        assert!(validate(&manifest(versions[0]), Channel::Stable).is_err());
        assert_eq!(
            Channel::initial(&Version::parse(versions[0]).unwrap()),
            Channel::Preview
        );
    }
    #[test]
    fn linux_requires_its_appimage_and_is_part_of_the_complete_manifest() {
        let mut m = manifest("0.2.0");
        assert!(validate(&m, Channel::Stable).is_ok());
        m["platforms"]["linux-x86_64"]["url"] =
            format!("{BASE_URL}/releases/v0.2.0/linux.exe").into();
        assert!(validate(&m, Channel::Stable).is_err());
        m["platforms"]
            .as_object_mut()
            .unwrap()
            .remove("linux-x86_64");
        assert!(validate(&m, Channel::Stable).is_err());
    }
    #[test]
    fn rejects_incomplete_or_untrusted_metadata() {
        let mut m = manifest("0.2.0");
        m["platforms"][TARGETS[0]]["url"] = "https://evil.example/a.app.tar.gz".into();
        assert!(validate(&m, Channel::Stable).is_err());
        let mut m = manifest("0.2.0");
        m["sourceweft"] = Value::Null;
        assert!(validate(&m, Channel::Stable).is_err());
        let mut m = manifest("0.2.0");
        m["sourceweft"]["distribution"] = "paused".into();
        assert!(validate(&m, Channel::Stable).is_ok());
        assert!(active(&m).is_err());
    }
}
