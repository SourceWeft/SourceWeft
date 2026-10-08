//! The same chunk addresses and plan schema are consumed by sync restore and FUSE.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, BTreeMap};
use std::io::Read;
use std::time::Duration;

pub const MAX_CHUNK_BYTES: u32 = 4 * 1024 * 1024;
pub const MAX_COMPRESSED_BYTES: u32 = 8 * 1024 * 1024;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ChunkRef(pub String, pub u32);
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ChunkLoc(pub String, pub u64, pub u32, pub u32);
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WireEntry {
    pub p: String,
    pub k: char,
    pub m: u32,
    #[serde(with = "ns_string")]
    pub t: i64,
    pub s: u64,
    #[serde(default)] pub l: Option<String>,
    #[serde(default)] pub c: Vec<ChunkRef>,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct RestorePlan {
    pub volume: String,
    pub attachment: String,
    pub seq: u64,
    pub entries: Vec<WireEntry>,
    pub chunks: HashMap<String, ChunkLoc>,
    pub packs: HashMap<String, String>,
}
impl RestorePlan {
    pub fn validate(&self) -> Result<()> {
        if self.volume.is_empty() || self.attachment.is_empty() || self.seq > SAFE_INTEGER { bail!("invalid plan identity or sequence"); }
        let mut paths = HashMap::new();
        let mut total = 0u64;
        for entry in &self.entries {
            if entry.p.starts_with(".sourceweft") || entry.p.is_empty() || entry.p.contains('\0') || entry.p.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.len() > 255) { bail!("invalid volume path"); }
            if paths.insert(entry.p.as_str(), entry.k).is_some() { bail!("duplicate volume path"); }
            if entry.m > 0o7777 || entry.s > SAFE_INTEGER { bail!("invalid entry metadata"); }
            total = total.checked_add(entry.s).filter(|sum| *sum <= SAFE_INTEGER).context("volume length exceeds safe integer bounds")?;
            match entry.k {
                'f' => {
                    if entry.l.is_some() { bail!("file has a symlink target"); }
                    let mut size = 0u64;
                    for ChunkRef(id, raw) in &entry.c {
                        if !valid_hash(id) || *raw == 0 || *raw > MAX_CHUNK_BYTES { bail!("invalid chunk reference"); }
                        let loc = self.chunks.get(id).context("chunk locator missing")?;
                        validate_location(loc)?;
                        if loc.3 != *raw || !self.packs.contains_key(&loc.0) { bail!("chunk locator disagrees with file"); }
                        size = size.checked_add(*raw as u64).context("file length overflow")?;
                    }
                    if size != entry.s { bail!("file length disagrees with chunks"); }
                }
                'd' if entry.s == 0 && entry.c.is_empty() && entry.l.is_none() => {},
                'l' if entry.s == 0 && entry.c.is_empty() && entry.l.as_ref().map(|link| !link.contains('\0')).unwrap_or(false) => {},
                _ => bail!("invalid entry kind or shape"),
            }
        }
        for path in paths.keys() {
            let mut parent = *path;
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                if paths.get(prefix) != Some(&'d') { bail!("parent directory is missing or has another type"); }
                parent = prefix;
            }
        }
        Ok(())
    }
}
fn valid_hash(id: &str) -> bool { id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn validate_location(loc: &ChunkLoc) -> Result<()> {
    if loc.0.is_empty() || loc.2 == 0 || loc.2 > MAX_COMPRESSED_BYTES || loc.3 == 0 || loc.3 > MAX_CHUNK_BYTES
        || loc.1.checked_add(loc.2 as u64).filter(|end| *end <= SAFE_INTEGER).is_none() { bail!("invalid chunk locator bounds"); }
    Ok(())
}
pub fn decode_chunk(id: &str, loc: &ChunkLoc, compressed: &[u8]) -> Result<Vec<u8>> {
    validate_location(loc)?;
    if !valid_hash(id) || compressed.len() != loc.2 as usize { bail!("invalid compressed chunk length or identity"); }
    let data = zstd::bulk::decompress(compressed, loc.3 as usize).context("chunk decompression failed")?;
    if data.len() != loc.3 as usize || blake3::hash(&data).to_hex().as_str() != id { bail!("chunk integrity mismatch"); }
    Ok(data)
}
#[derive(Clone)]
pub struct Fetcher { agent: ureq::Agent }
impl Default for Fetcher {
    fn default() -> Self {
        Self { agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(5)).max_idle_connections_per_host(8).build() }
    }
}
impl Fetcher {
    pub fn chunk(&self, id: &str, loc: &ChunkLoc, url: &str) -> Result<Vec<u8>> {
        validate_location(loc)?;
        if !url.starts_with("https://") && !url.starts_with("http://") { bail!("unsupported chunk URL scheme"); }
        let end = loc.1 + loc.2 as u64 - 1;
        let response = self.agent.get(url).set("Range", &format!("bytes={}-{}", loc.1, end)).call().map_err(|error| match error {
            ureq::Error::Status(code, _) => anyhow::anyhow!("chunk GET rejected with HTTP {code}"),
            _ => anyhow::anyhow!("chunk GET transport failed"),
        })?;
        if response.status() != 206 { bail!("chunk GET must return a ranged response"); }
        let expected_prefix = format!("bytes {}-{end}/", loc.1);
        let total = response.header("Content-Range").and_then(|header| header.strip_prefix(&expected_prefix)).and_then(|value| value.parse::<u64>().ok()).context("chunk Content-Range mismatch")?;
        if total <= end { bail!("chunk Content-Range exceeds object length"); }
        let mut compressed = Vec::with_capacity(loc.2 as usize);
        response.into_reader().take(loc.2 as u64 + 1).read_to_end(&mut compressed).context("chunk body read failed")?;
        decode_chunk(id, loc, &compressed)
    }
}
pub mod ns_string {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> { serializer.serialize_str(&value.to_string()) }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        #[derive(Deserialize)] #[serde(untagged)] enum Raw { S(String), N(i64) }
        match Raw::deserialize(deserializer)? { Raw::S(value) => value.parse().map_err(serde::de::Error::custom), Raw::N(value) if value.unsigned_abs() <= 9_007_199_254_740_991 => Ok(value), _ => Err(serde::de::Error::custom("unsafe numeric timestamp; use a decimal string")) }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn verifies_hash_length_and_decompression_limit() {
        let data = b"shared formal chunk"; let compressed = zstd::bulk::compress(data, 3).unwrap();
        let loc = ChunkLoc("p".into(), 0, compressed.len() as u32, data.len() as u32);
        let id = blake3::hash(data).to_hex().to_string();
        assert_eq!(decode_chunk(&id, &loc, &compressed).unwrap(), data);
        assert!(decode_chunk(&"0".repeat(64), &loc, &compressed).is_err());
        assert!(decode_chunk(&id, &ChunkLoc("p".into(), 0, compressed.len() as u32, 1), &compressed).is_err());
        assert!(decode_chunk(&id, &loc, &compressed[..compressed.len()-1]).is_err());
    }
    #[test] fn exact_timestamp_roundtrip_and_unsafe_number_rejected() {
        let entry: WireEntry = serde_json::from_str(r#"{"p":"file","k":"f","m":384,"t":"1791412345123456789","s":0}"#).unwrap();
        assert_eq!(entry.t, 1791412345123456789);
        assert_eq!(serde_json::to_value(&entry).unwrap()["t"], "1791412345123456789");
        assert!(serde_json::from_str::<WireEntry>(r#"{"p":"file","k":"f","m":384,"t":1791412345123456789,"s":0}"#).is_err());
    }
}

#[derive(Serialize, Deserialize)]
pub struct Manifest {
    pub v: u32,
    pub volume: String,
    pub attachment: String,
    pub boot_id: String,
    pub seq: u64,
    pub base: u64,
    /// A full manifest is a self-contained snapshot: paths it does not list no longer exist.
    #[serde(default)]
    pub full: bool,
    pub trigger: String,
    pub upserts: Vec<WireEntry>,
    pub deletes: Vec<String>,
    pub chunks: BTreeMap<String, ChunkLoc>,
    pub packs: Vec<(String, u64)>,
    pub unstable: Vec<String>,
    pub skipped: Vec<String>,
    pub ts_ms: u64,
}


/// Decode the bounded JSON tail of a formal immutable manifest object.
pub fn decode_manifest(body: &[u8], json_limit: usize) -> Result<Manifest> {
    if body.len() < 16 || &body[..8] != b"SWVOLM1\n" { bail!("invalid manifest header"); }
    let inline = u64::from_le_bytes(body[8..16].try_into().unwrap());
    let offset = inline.checked_add(16).filter(|n| *n <= body.len() as u64).context("manifest inline length invalid")? as usize;
    let decoder = zstd::stream::read::Decoder::new(&body[offset..]).context("invalid manifest compression")?;
    let mut json = Vec::new();
    decoder.take(json_limit as u64 + 1).read_to_end(&mut json)?;
    if json.len() > json_limit { bail!("manifest exceeds JSON budget"); }
    let manifest: Manifest = serde_json::from_slice(&json)?;
    if manifest.v != 1 { bail!("unsupported manifest protocol version"); }
    Ok(manifest)
}

pub fn raw_chunk_hash(data: &[u8]) -> String { blake3::hash(data).to_hex().to_string() }

#[cfg(test)]
mod ranged_read_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve_once(status: u16, range: String, body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let count = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]).to_ascii_lowercase();
            assert!(request.contains("range: bytes=5-"));
            write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Range: {range}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(&body).unwrap();
        });
        (url, worker)
    }
    #[test]
    fn range_identity_is_checked_before_decoding() {
        let bytes = b"shared range fixture";
        let compressed = zstd::bulk::compress(bytes, 3).unwrap();
        let id = raw_chunk_hash(bytes);
        let loc = ChunkLoc("p".into(), 5, compressed.len() as u32, bytes.len() as u32);
        let end = 5 + compressed.len() - 1;
        for (status, range, success) in [
            (206, format!("bytes 5-{end}/1000"), true),
            (200, format!("bytes 5-{end}/1000"), false),
            (206, format!("bytes 4-{end}/1000"), false),
            (206, format!("bytes 5-{end}/{end}"), false),
        ] {
            let (url, worker) = serve_once(status, range, compressed.clone());
            assert_eq!(Fetcher::default().chunk(&id, &loc, &url).is_ok(), success);
            worker.join().unwrap();
        }
    }
    #[test]
    fn plan_rejects_parent_conflicts_and_bad_chunk_lengths() {
        let raw = r#"{"volume":"v","attachment":"a","seq":1,"entries":[{"p":"a","k":"f","m":384,"t":"1","s":0},{"p":"a/b","k":"f","m":384,"t":"1","s":0}],"chunks":{},"packs":{}}"#;
        assert!(serde_json::from_str::<RestorePlan>(raw).unwrap().validate().is_err());
        let raw = r#"{"volume":"v","attachment":"a","seq":1,"entries":[{"p":"a","k":"f","m":384,"t":"1","s":1}],"chunks":{},"packs":{}}"#;
        assert!(serde_json::from_str::<RestorePlan>(raw).unwrap().validate().is_err());
    }
}
