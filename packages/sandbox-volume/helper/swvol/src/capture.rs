//! Durable receipts for immutable packs not yet referenced by a committed WAL.
//! This journal is an upload optimization only: it never advances State or seq.
use super::*;
use bincode::Options;
const DIRECTORY: &str = "capture";
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_RECEIPT: u64 = 32 * 1024 * 1024;
const MAX_TOTAL: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 65_536;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scope {
    pub v: u32,
    pub volume: String,
    pub attachment: String,
    pub boot_id: String,
    pub epoch: u64,
    pub base_seq: u64,
    pub pack_prefix: String,
    pub manifest_prefix: String,
}
impl Scope {
    fn new(st: &State, slots: &Slots) -> Result<Self> {
        if slots.volume != st.volume || slots.attachment != st.attachment {
            bail!("CAPTURE_SCOPE_MISMATCH: slot owner differs from local state");
        }
        let epoch = slots
            .manifest_prefix
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .context("capture manifest epoch missing")?
            .parse::<u64>()
            .context("capture manifest epoch invalid")?;
        let scope = Self {
            v: 1,
            volume: st.volume.clone(),
            attachment: st.attachment.clone(),
            boot_id: st.boot_id.clone(),
            epoch,
            base_seq: st.seq,
            pack_prefix: slots.pack_prefix.clone(),
            manifest_prefix: slots.manifest_prefix.clone(),
        };
        scope.validate()?;
        Ok(scope)
    }
    fn validate(&self) -> Result<()> {
        if self.v != 1
            || [
                self.volume.as_str(),
                self.attachment.as_str(),
                self.boot_id.as_str(),
            ]
            .iter()
            .any(|v| v.is_empty() || v.len() > 256 || v.contains('\0'))
            || self.epoch > MAX_SAFE
            || self.base_seq >= MAX_SAFE
            || self.pack_prefix != format!("att/{}/p/", self.attachment)
            || self.manifest_prefix != format!("att/{}/m/{}/", self.attachment, self.epoch)
        {
            bail!("CAPTURE_SCOPE_INVALID: preserving upload receipts");
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub scope: Scope,
    pub key: String,
    pub bytes: u64,
    pub chunks: BTreeMap<String, ChunkLoc>,
}
#[derive(Serialize, Deserialize)]
struct Sealed<T> {
    body: T,
    checksum: String,
}
fn sealed<T: Serialize>(body: T) -> Result<Sealed<T>> {
    let checksum = blake3::hash(&serde_json::to_vec(&body)?)
        .to_hex()
        .to_string();
    Ok(Sealed { body, checksum })
}
fn read<T: for<'de> Deserialize<'de> + Serialize>(
    directory: &Path,
    name: &str,
    limit: u64,
) -> Result<T> {
    let metadata = fs::symlink_metadata(directory.join(name))?;
    if !metadata.is_file() || metadata.len() > limit {
        bail!("capture record type or size is invalid");
    }
    let value: Sealed<T> = swvol_core::control::read_private(directory, name, limit)?;
    if value.checksum
        != blake3::hash(&serde_json::to_vec(&value.body)?)
            .to_hex()
            .as_str()
    {
        bail!("CAPTURE_CHECKSUM_MISMATCH: preserving upload receipts");
    }
    // A previous attempt may have failed during the final directory fsync. A
    // record is reusable only after its bytes AND directory are synced now.
    File::open(directory.join(name))?.sync_all()?;
    File::open(directory)?.sync_all()?;
    Ok(value.body)
}
fn pack_number(scope: &Scope, key: &str) -> Result<u32> {
    let n = key
        .strip_prefix(&scope.pack_prefix)
        .context("capture pack prefix mismatch")?;
    if n.len() != 6 || !n.bytes().all(|b| b.is_ascii_digit()) {
        bail!("capture pack key is invalid");
    }
    Ok(n.parse()?)
}
fn validate_receipt(receipt: &Receipt, scope: &Scope) -> Result<u32> {
    if &receipt.scope != scope {
        bail!("CAPTURE_SCOPE_MISMATCH: explicit rebase recovery required");
    }
    let n = pack_number(scope, &receipt.key)?;
    if receipt.bytes == 0
        || receipt.bytes > (PACK_TARGET + swvol_core::MAX_COMPRESSED_BYTES as usize) as u64
        || receipt.chunks.is_empty()
    {
        bail!("capture pack bounds invalid");
    }
    let mut ranges = Vec::with_capacity(receipt.chunks.len());
    for (id, loc) in &receipt.chunks {
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || loc.0 != receipt.key
            || loc.2 == 0
            || loc.2 > swvol_core::MAX_COMPRESSED_BYTES
            || loc.3 == 0
            || loc.3 > swvol_core::MAX_CHUNK_BYTES
        {
            bail!("capture chunk metadata invalid");
        }
        let end = loc
            .1
            .checked_add(loc.2 as u64)
            .context("capture chunk overflow")?;
        if end > receipt.bytes {
            bail!("capture chunk exceeds its uploaded pack");
        }
        ranges.push((loc.1, end));
    }
    ranges.sort_unstable();
    let mut offset = 0;
    for (from, to) in ranges {
        if from != offset {
            bail!("capture pack has overlapping or missing ranges");
        }
        offset = to;
    }
    if offset != receipt.bytes {
        bail!("capture pack length mismatch");
    }
    Ok(n)
}
fn next_pack(root: &Path) -> Result<u32> {
    match fs::read_to_string(meta_dir(root).join("pack.next")) {
        Ok(s) => Ok(s.trim().parse().context("pack counter is corrupt")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.into()),
    }
}
pub struct Loaded {
    pub scope: Scope,
    pub locs: BTreeMap<String, ChunkLoc>,
    pub packs: Vec<(String, u64)>,
    bytes: u64,
    files: usize,
    digest: String,
}
fn load(directory: &Path) -> Result<Loaded> {
    swvol_core::control::validate_directory(directory)?;
    let scope: Scope = read(directory, "scope.json", 4096)?;
    scope.validate()?;
    let mut paths = Vec::new();
    for entry in fs::read_dir(directory)? {
        if paths.len() == MAX_FILES {
            bail!("CAPTURE_LIMIT: too many receipt files; preserving them");
        }
        paths.push(entry?);
    }
    // The directory itself may have survived an earlier publication whose
    // parent fsync failed. Establish durability before accepting its receipts.
    File::open(directory.parent().context("capture has no parent")?)?.sync_all()?;
    paths.sort_by_key(|e| e.file_name());
    let mut result = Loaded {
        scope: scope.clone(),
        locs: BTreeMap::new(),
        packs: Vec::new(),
        bytes: 0,
        files: paths.len(),
        digest: String::new(),
    };
    let mut digest = blake3::Hasher::new();
    digest.update(&serde_json::to_vec(&scope)?);
    for path in paths {
        let name = path
            .file_name()
            .into_string()
            .map_err(|_| anyhow!("invalid capture filename"))?;
        let md = fs::symlink_metadata(path.path())?;
        if !md.is_file() || md.uid() != unsafe { libc::geteuid() } || md.mode() & 0o077 != 0 {
            bail!("invalid capture receipt ownership or type");
        }
        result.bytes = result
            .bytes
            .checked_add(md.len())
            .context("capture size overflow")?;
        if result.bytes > MAX_TOTAL || md.len() > MAX_RECEIPT {
            bail!("CAPTURE_LIMIT: receipt byte budget exceeded; preserving them");
        }
        if name == "scope.json" {
            continue;
        }
        // Incomplete atomic writes are never reused. Count them against limits
        // and preserve their exact bytes for diagnosis/rebase recovery.
        if name.starts_with('.') && name.ends_with(".tmp") {
            continue;
        }
        if !name.starts_with("pack-") || !name.ends_with(".json") {
            bail!("unknown capture journal entry");
        }
        let receipt: Receipt = read(directory, &name, MAX_RECEIPT)?;
        let n = validate_receipt(&receipt, &scope)?;
        if name != format!("pack-{n:06}.json") {
            bail!("capture receipt filename disagrees with key");
        }
        digest.update(&serde_json::to_vec(&receipt)?);
        result.packs.push((receipt.key.clone(), receipt.bytes));
        for (id, loc) in receipt.chunks {
            if result.locs.insert(id, loc).is_some() {
                bail!("capture contains conflicting duplicate chunk receipts");
            }
        }
    }
    result.digest = digest.finalize().to_hex().to_string();
    Ok(result)
}
pub struct Writer {
    directory: PathBuf,
    pub scope: Scope,
    budget: Mutex<(u64, usize)>,
}
impl Writer {
    pub fn receipt(&self, key: String, bytes: u64, chunks: BTreeMap<String, ChunkLoc>) -> Receipt {
        Receipt {
            scope: self.scope.clone(),
            key,
            bytes,
            chunks,
        }
    }
    pub fn save(&self, receipt: Receipt) -> Result<()> {
        let n = validate_receipt(&receipt, &self.scope)?;
        let name = format!("pack-{n:06}.json");
        let value = sealed(receipt)?;
        let length = serde_json::to_vec(&value)?.len() as u64;
        if length > MAX_RECEIPT {
            bail!("CAPTURE_LIMIT: individual receipt is too large");
        }
        let mut budget = self.budget.lock().unwrap();
        if budget.0 + length > MAX_TOTAL || budget.1 >= MAX_FILES {
            bail!("CAPTURE_LIMIT: upload receipt budget exhausted");
        }
        if fs::symlink_metadata(self.directory.join(&name)).is_ok() {
            bail!("capture receipt already exists; refusing overwrite");
        }
        #[cfg(test)]
        if FAIL_RECEIPT_WRITE.with(|f| f.get()) {
            return Err(std::io::Error::from_raw_os_error(28).into());
        }
        swvol_core::control::atomic_json(&self.directory, &name, &value)?;
        budget.0 += length;
        budget.1 += 1;
        Ok(())
    }
}
pub fn prepare_rebase(root: &Path, st: &State, slots: &Slots, head: u64) -> Result<()> {
    let directory = meta_dir(root).join(DIRECTORY);
    if !directory.try_exists()? {
        return Ok(());
    }
    let mut expected = Scope::new(st, slots)?;
    expected.base_seq = head;
    expected.validate()?;
    // The same explicitly requested epoch/head may resume its own paused upload.
    // A different or unreadable scope is preserved verbatim in recovery.
    match read::<Scope>(&directory, "scope.json", 4096) {
        Ok(current) if current == expected => Ok(()),
        _ => archive(root, "rebase", false),
    }
}

pub fn open(root: &Path, st: &State, slots: &Slots) -> Result<(Arc<Writer>, Loaded)> {
    let expected = Scope::new(st, slots)?;
    let directory = meta_dir(root).join(DIRECTORY);
    if directory.try_exists()? {
        let current: Scope = read(&directory, "scope.json", 4096)?;
        current.validate()?;
        if current.volume == expected.volume
            && current.attachment == expected.attachment
            && current.boot_id == expected.boot_id
            && current.epoch == expected.epoch
            && current.base_seq < expected.base_seq
        {
            // Only a durably stored next sequence proves interrupted housekeeping.
            let prefix = state_prefix(root)?;
            if current.base_seq.checked_add(1) != Some(expected.base_seq)
                || prefix.seq != expected.base_seq
                || prefix.volume != expected.volume
                || prefix.attachment != expected.attachment
                || prefix.boot_id != expected.boot_id
            {
                bail!("CAPTURE_BASE_MISMATCH: preserving upload receipts");
            }
            archive(root, "committed", true)?;
        } else if current != expected {
            bail!("CAPTURE_SCOPE_MISMATCH: explicit rebase recovery required");
        }
    }
    if !directory.try_exists()? {
        let parent = safe_fs::Directory::open_root(&meta_dir(root))?;
        let temporary = format!(
            ".capture-init-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        );
        let staging = parent.new_directory(&temporary)?;
        let initialize = (|| -> Result<()> {
            #[cfg(test)]
            if FAIL_SCOPE_WRITE.with(|fault| fault.get()) {
                return Err(std::io::Error::from_raw_os_error(28).into());
            }
            staging.atomic_write(
                "scope.json",
                &serde_json::to_vec(&sealed(expected.clone())?)?,
            )?;
            parent.move_entry_to(&temporary, &parent, DIRECTORY)?;
            Ok(())
        })();
        if let Err(error) = initialize {
            // Never expose a half-initialized active journal. A failed private
            // staging cleanup may remain as forensic data, outside active capture.
            let _ = fs::remove_dir_all(meta_dir(root).join(&temporary));
            return Err(error);
        }
    }
    let loaded = load(&directory)?;
    if loaded.scope != expected {
        bail!("CAPTURE_SCOPE_MISMATCH: preserving receipt data");
    }
    let next = next_pack(root)?;
    if loaded.packs.iter().any(|(key, _)| {
        pack_number(&loaded.scope, key)
            .map(|n| n >= next)
            .unwrap_or(true)
    }) {
        bail!("capture pack counter disagrees with durable receipts");
    }
    let writer = Arc::new(Writer {
        directory,
        scope: expected,
        budget: Mutex::new((loaded.bytes, loaded.files)),
    });
    Ok((writer, loaded))
}
pub fn has_pending(root: &Path) -> Result<bool> {
    let directory = meta_dir(root).join(DIRECTORY);
    if !directory.try_exists()? {
        return Ok(false);
    }
    let loaded = load(&directory)?;
    Ok(!loaded.packs.is_empty() || loaded.files > 1)
}
pub fn archive(root: &Path, reason: &str, remove: bool) -> Result<()> {
    let directory = meta_dir(root).join(DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
        Ok(md) if !md.is_dir() => bail!("capture journal is not a real directory"),
        _ => {}
    }
    let recovery = meta_dir(root).join("recovery");
    fs::create_dir_all(&recovery)?;
    fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700))?;
    swvol_core::control::validate_directory(&recovery)?;
    for attempt in 0..100 {
        let to = recovery.join(format!(
            "capture-{reason}-{}-{}-{attempt}",
            now_ms(),
            std::process::id()
        ));
        if to.try_exists()? {
            continue;
        }
        fs::rename(&directory, &to)?;
        File::open(&recovery)?.sync_all()?;
        File::open(meta_dir(root))?.sync_all()?;
        if remove {
            fs::remove_dir_all(to)?;
            File::open(&recovery)?.sync_all()?;
        }
        return Ok(());
    }
    bail!("cannot reserve capture archive path")
}
pub fn committed(root: &Path, old_seq: u64) -> Result<()> {
    let directory = meta_dir(root).join(DIRECTORY);
    if !directory.try_exists()? {
        return Ok(());
    }
    let scope: Scope = read(&directory, "scope.json", 4096)?;
    if scope.base_seq != old_seq {
        bail!("capture cleanup base disagrees with committed state");
    }
    archive(root, "committed", true)
}
#[derive(Serialize)]
pub struct Progress {
    v: u32,
    volume: String,
    attachment: String,
    boot_id: String,
    epoch: u64,
    base_seq: u64,
    next_pack: u32,
    uploaded_packs: u64,
    uploaded_chunks: u64,
    uploaded_raw_bytes: u64,
    receipt_digest: String,
    recent_uploaded_pack_numbers: Vec<u32>,
}
impl Progress {
    pub fn has_uploads(&self) -> bool {
        self.uploaded_packs > 0
    }
}
#[derive(Deserialize)]
struct StatePrefix {
    volume: String,
    attachment: String,
    boot_id: String,
    seq: u64,
}
fn state_prefix(root: &Path) -> Result<StatePrefix> {
    // Read only the small fixed prefix, not another copy of the entire State.
    Ok(bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .allow_trailing_bytes()
        .with_limit(4096)
        .deserialize_from(File::open(state_path(root))?)?)
}
pub fn progress(root: &Path, rebase: Option<u64>) -> Result<Option<Progress>> {
    let directory = meta_dir(root).join(DIRECTORY);
    if !directory.try_exists()? {
        return Ok(None);
    }
    let prefix = state_prefix(root)?;
    let st = State {
        volume: prefix.volume,
        attachment: prefix.attachment,
        boot_id: prefix.boot_id,
        seq: rebase.unwrap_or(prefix.seq),
        ..State::default()
    };
    let slots = load_slots(root)?;
    let expected = Scope::new(&st, &slots)?;
    let loaded = load(&directory)?;
    if loaded.scope != expected || expected.boot_id != boot_id() {
        bail!("CAPTURE_SCOPE_MISMATCH: refusing unscoped progress");
    }
    let next = next_pack(root)?;
    let mut raw = 0u64;
    for loc in loaded.locs.values() {
        raw = raw
            .checked_add(loc.3 as u64)
            .filter(|n| *n <= MAX_SAFE)
            .context("capture raw byte count exceeds safe integer range")?;
    }
    if loaded.packs.iter().any(|(key, _)| {
        pack_number(&expected, key)
            .map(|n| n >= next)
            .unwrap_or(true)
    }) {
        bail!("capture progress exceeds its durable counter");
    }
    let recent_uploaded_pack_numbers = loaded
        .packs
        .iter()
        .skip(loaded.packs.len().saturating_sub(64))
        .map(|(key, _)| pack_number(&expected, key))
        .collect::<Result<Vec<_>>>()?;
    let progress = Progress {
        v: 1,
        volume: expected.volume,
        attachment: expected.attachment,
        boot_id: expected.boot_id,
        epoch: expected.epoch,
        base_seq: expected.base_seq,
        next_pack: next,
        uploaded_packs: loaded.packs.len() as u64,
        uploaded_chunks: loaded.locs.len() as u64,
        uploaded_raw_bytes: raw,
        receipt_digest: loaded.digest,
        recent_uploaded_pack_numbers,
    };
    if serde_json::to_vec(&progress)?.len() >= 4096 {
        bail!("capture progress exceeds 4KiB");
    }
    Ok(Some(progress))
}
#[cfg(test)]
thread_local! {static FAIL_RECEIPT_WRITE:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        state: State,
        slots: Slots,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "swvol-receipt-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(meta_dir(&root)).unwrap();
            fs::set_permissions(meta_dir(&root), fs::Permissions::from_mode(0o700)).unwrap();
            let state = State {
                volume: "v".into(),
                attachment: "a".into(),
                boot_id: boot_id(),
                seq: 5,
                ..State::default()
            };
            let slots = Slots {
                volume: "v".into(),
                attachment: "a".into(),
                pack_prefix: "att/a/p/".into(),
                manifest_prefix: "att/a/m/1/".into(),
                packs: HashMap::new(),
                manifests: HashMap::new(),
                manifest_reads: HashMap::new(),
            };
            save_state(&root, &state).unwrap();
            fs::write(
                meta_dir(&root).join("slots.json"),
                serde_json::to_vec(&slots).unwrap(),
            )
            .unwrap();
            Self { root, state, slots }
        }
        fn receipt(&self, writer: &Writer, n: u32) -> Receipt {
            let raw = vec![n as u8; 4096];
            let data = zstd::bulk::compress(&raw, 3).unwrap();
            let id = blake3::hash(&raw).to_hex().to_string();
            let key = format!("att/a/p/{n:06}");
            writer.receipt(
                key.clone(),
                data.len() as u64,
                [(id, ChunkLoc(key, 0, data.len() as u32, raw.len() as u32))]
                    .into_iter()
                    .collect(),
            )
        }
        fn counter(&self, n: u32) {
            atomic_write(
                &meta_dir(&self.root).join("pack.next"),
                n.to_string().as_bytes(),
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn failed_scope_initialization_never_exposes_an_active_partial_journal() {
        let f = Fixture::new();
        FAIL_SCOPE_WRITE.with(|flag| flag.set(true));
        let result = open(&f.root, &f.state, &f.slots);
        FAIL_SCOPE_WRITE.with(|flag| flag.set(false));
        assert_eq!(error_exit_code(&result.err().unwrap()), 78);
        assert!(!meta_dir(&f.root).join(DIRECTORY).exists());
        assert!(open(&f.root, &f.state, &f.slots)
            .unwrap()
            .1
            .packs
            .is_empty());
    }
    #[test]
    fn durable_receipt_survives_reopen_without_advancing_state() {
        let f = Fixture::new();
        let before = fs::read(state_path(&f.root)).unwrap();
        let (writer, _) = open(&f.root, &f.state, &f.slots).unwrap();
        f.counter(1);
        writer.save(f.receipt(&writer, 0)).unwrap();
        drop(writer);
        let (_, loaded) = open(&f.root, &f.state, &f.slots).unwrap();
        assert_eq!(loaded.locs.len(), 1);
        assert_eq!(loaded.packs.len(), 1);
        assert_eq!(fs::read(state_path(&f.root)).unwrap(), before);
        let progress = serde_json::to_value(progress(&f.root, None).unwrap().unwrap()).unwrap();
        assert_eq!(progress["base_seq"], 5);
        assert_eq!(progress["next_pack"], 1);
        assert_eq!(progress["uploaded_packs"], 1);
        assert_eq!(progress["uploaded_chunks"], 1);
        assert_eq!(progress["uploaded_raw_bytes"], 4096);
        assert_eq!(progress["receipt_digest"].as_str().unwrap().len(), 64);
        assert!(serde_json::to_vec(&progress).unwrap().len() < 4096);
    }
    #[test]
    fn progress_reports_actual_pack_numbers_with_inline_and_crash_holes() {
        let f = Fixture::new();
        let (writer, _) = open(&f.root, &f.state, &f.slots).unwrap();
        // Counter 0 may have been consumed by an inline commit; reservation 2
        // may have died before PUT. Neither is an uploaded receipt.
        f.counter(4);
        writer.save(f.receipt(&writer, 1)).unwrap();
        writer.save(f.receipt(&writer, 3)).unwrap();
        let report = serde_json::to_value(progress(&f.root, None).unwrap().unwrap()).unwrap();
        assert_eq!(report["next_pack"], 4);
        assert_eq!(report["uploaded_packs"], 2);
        assert_eq!(
            report["recent_uploaded_pack_numbers"],
            serde_json::json!([1, 3])
        );
        for n in 4..70 {
            f.counter(n + 1);
            writer.save(f.receipt(&writer, n)).unwrap();
        }
        let report = progress(&f.root, None).unwrap().unwrap();
        assert_eq!(report.uploaded_packs, 68);
        assert_eq!(
            report.recent_uploaded_pack_numbers,
            (6..70).collect::<Vec<_>>()
        );
        assert!(serde_json::to_vec(&report).unwrap().len() < 4096);
    }
    #[test]
    fn failed_receipt_write_is_not_reused_and_retry_can_persist_it() {
        let f = Fixture::new();
        let (writer, _) = open(&f.root, &f.state, &f.slots).unwrap();
        f.counter(1);
        FAIL_RECEIPT_WRITE.with(|flag| flag.set(true));
        let error = writer.save(f.receipt(&writer, 0)).unwrap_err();
        FAIL_RECEIPT_WRITE.with(|flag| flag.set(false));
        assert_eq!(error_exit_code(&error), 78);
        let (_, loaded) = open(&f.root, &f.state, &f.slots).unwrap();
        assert!(loaded.locs.is_empty());
        writer.save(f.receipt(&writer, 0)).unwrap();
        assert_eq!(open(&f.root, &f.state, &f.slots).unwrap().1.locs.len(), 1);
    }
    #[test]
    fn epoch_change_requires_explicit_archive_and_same_rebase_can_resume() {
        let mut f = Fixture::new();
        let (writer, _) = open(&f.root, &f.state, &f.slots).unwrap();
        f.counter(1);
        writer.save(f.receipt(&writer, 0)).unwrap();
        let bytes = fs::read(meta_dir(&f.root).join("capture/pack-000000.json")).unwrap();
        f.slots.manifest_prefix = "att/a/m/2/".into();
        assert!(open(&f.root, &f.state, &f.slots).is_err());
        assert_eq!(
            fs::read(meta_dir(&f.root).join("capture/pack-000000.json")).unwrap(),
            bytes
        );
        prepare_rebase(&f.root, &f.state, &f.slots, 3).unwrap();
        let archived = fs::read_dir(meta_dir(&f.root).join("recovery"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(archived.join("pack-000000.json")).unwrap(), bytes);
        let mut rebased = State {
            volume: f.state.volume.clone(),
            attachment: f.state.attachment.clone(),
            boot_id: f.state.boot_id.clone(),
            seq: 3,
            ..State::default()
        };
        let (writer, _) = open(&f.root, &rebased, &f.slots).unwrap();
        f.counter(2);
        writer.save(f.receipt(&writer, 1)).unwrap();
        prepare_rebase(&f.root, &f.state, &f.slots, 3).unwrap();
        assert_eq!(open(&f.root, &rebased, &f.slots).unwrap().1.locs.len(), 1);
        fs::write(
            meta_dir(&f.root).join("slots.json"),
            serde_json::to_vec(&f.slots).unwrap(),
        )
        .unwrap();
        assert!(progress(&f.root, None).is_err());
        assert_eq!(progress(&f.root, Some(3)).unwrap().unwrap().base_seq, 3);
        rebased.seq = 4;
        assert!(
            open(&f.root, &rebased, &f.slots).is_err(),
            "an in-memory sequence change alone cannot discard receipts"
        );
    }
    #[test]
    fn corrupt_and_oversized_records_are_retained_and_rejected() {
        let f = Fixture::new();
        let (writer, _) = open(&f.root, &f.state, &f.slots).unwrap();
        f.counter(1);
        writer.save(f.receipt(&writer, 0)).unwrap();
        let path = meta_dir(&f.root).join("capture/pack-000000.json");
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 2;
        bytes[last] ^= 1;
        fs::write(&path, &bytes).unwrap();
        assert!(open(&f.root, &f.state, &f.slots).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_RECEIPT + 1)
            .unwrap();
        assert!(open(&f.root, &f.state, &f.slots).is_err());
        assert_eq!(fs::metadata(path).unwrap().len(), MAX_RECEIPT + 1);
    }
    #[test]
    fn incomplete_temporary_receipt_is_never_progress() {
        let f = Fixture::new();
        let (_writer, _) = open(&f.root, &f.state, &f.slots).unwrap();
        let path = meta_dir(&f.root).join("capture/.incomplete.tmp");
        fs::write(&path, b"partial acknowledged-upload metadata").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(progress(&f.root, None).unwrap().unwrap().uploaded_chunks, 0);
        assert!(path.exists());
    }
    #[test]
    fn state_commit_is_required_before_receipt_housekeeping() {
        let mut f = Fixture::new();
        let (writer, _) = open(&f.root, &f.state, &f.slots).unwrap();
        f.counter(1);
        let receipt = f.receipt(&writer, 0);
        writer.save(receipt.clone()).unwrap();
        let apply = PendingApply {
            seq: 6,
            rebase: false,
            next_pack: 0,
            upserts: vec![],
            deletes: vec![],
            new_locs: receipt.chunks,
            unstable: vec![],
        };
        FAIL_STATE_SAVE.with(|flag| flag.set(true));
        let result = commit_pending(&f.root, &mut f.state, apply);
        FAIL_STATE_SAVE.with(|flag| flag.set(false));
        assert!(result.is_err());
        assert_eq!(f.state.seq, 5);
        assert!(meta_dir(&f.root).join("capture/pack-000000.json").exists());
        let (_, loaded) = open(&f.root, &f.state, &f.slots).unwrap();
        commit_pending(
            &f.root,
            &mut f.state,
            PendingApply {
                seq: 6,
                rebase: false,
                next_pack: 0,
                upserts: vec![],
                deletes: vec![],
                new_locs: loaded.locs,
                unstable: vec![],
            },
        )
        .unwrap();
        assert_eq!(f.state.seq, 6);
        assert!(!meta_dir(&f.root).join("capture").exists());
    }
}

#[cfg(test)]
thread_local! {static FAIL_SCOPE_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };}
