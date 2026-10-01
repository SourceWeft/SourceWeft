//! The restore plan: metadata of every entry plus where its bytes live.
//!
//! All file contents are laid out back to back in one logical stream (entries in manifest order);
//! the stream is cut into fixed-size pack objects. `o` is the offset of a file in that stream, so
//! any byte of any file is one ranged GET away.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entry {
    pub p: String,
    /// "f" file, "d" directory, "l" symlink
    pub k: String,
    pub m: u32,
    /// mtime in nanoseconds
    pub t: i64,
    #[serde(default)]
    pub s: u64,
    #[serde(default)]
    pub o: u64,
    #[serde(default)]
    pub l: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Plan {
    pub pack_size: u64,
    pub total: u64,
    /// One URL per pack (pre-signed GET, or file:///path for local tests).
    pub packs: Vec<String>,
    pub entries: Vec<Entry>,
}

impl Plan {
    pub fn load(path: &str) -> anyhow::Result<Plan> {
        let raw = std::fs::read(path)?;
        Ok(serde_json::from_slice(&raw)?)
    }
}
