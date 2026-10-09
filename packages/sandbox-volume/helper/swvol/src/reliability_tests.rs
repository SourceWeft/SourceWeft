use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("swvol-reliability-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(meta_dir(&root)).unwrap();
        Self(root)
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn entry(size: u64) -> Entry { Entry { kind: 'f', mode: 0o600, mtime_ns: 1, size, link: None, chunks: vec![], ino: 1, ctime_ns: 1 } }
fn slots() -> Slots { Slots { volume: "v".into(), attachment: "a".into(), pack_prefix: "p/".into(), manifest_prefix: "m/".into(), packs: HashMap::new(), manifests: HashMap::new(), manifest_reads: HashMap::new() } }
fn apply() -> PendingApply {
    PendingApply { seq: 2, rebase: false, next_pack: 8,
        upserts: vec![("replace".into(), entry(22)), ("insert".into(), entry(33))],
        deletes: vec!["delete".into()],
        new_locs: [("old".into(), ChunkLoc("new".into(), 0, 2, 2)), ("new".into(), ChunkLoc("new".into(), 2, 2, 2))].into_iter().collect(),
        unstable: vec![] }
}
#[test]
fn enospc_rolls_back_only_changed_state_then_retry_persists_it() {
    let f = Fixture::new();
    let mut st = State { seq: 1, next_pack: 3, ..State::default() };
    st.entries.insert("replace".into(), entry(2));
    st.entries.insert("delete".into(), entry(3));
    st.entries.insert("untouched".into(), entry(4));
    st.have.insert("old".into(), ChunkLoc("old".into(), 0, 1, 1));
    save_state(&f.0, &st).unwrap();
    let before = bincode::serialize(&st).unwrap();
    FAIL_STATE_SAVE.with(|v| v.set(true));
    let error = commit_pending(&f.0, &mut st, apply()).unwrap_err();
    FAIL_STATE_SAVE.with(|v| v.set(false));
    assert_eq!(error_exit_code(&error), 78);
    assert_eq!(bincode::serialize(&st).unwrap(), before);
    assert_eq!(fs::read(state_path(&f.0)).unwrap(), before);
    commit_pending(&f.0, &mut st, apply()).unwrap();
    assert_eq!(st.seq, 2);
    assert_eq!(st.entries["replace"].size, 22);
    assert!(!st.entries.contains_key("delete"));
    assert_eq!(load_state(&f.0).unwrap().unwrap().seq, 2);
}
#[test]
fn malformed_and_unreadable_pending_are_preserved() {
    let f = Fixture::new();
    let pending = meta_dir(&f.0).join("pending.manifest");
    fs::write(&pending, b"damaged journal").unwrap();
    assert!(recover_pending(&f.0, &mut State::default(), &slots()).is_err());
    assert_eq!(fs::read(&pending).unwrap(), b"damaged journal");
    fs::remove_file(&pending).unwrap();
    fs::create_dir(&pending).unwrap();
    assert!(recover_pending(&f.0, &mut State::default(), &slots()).is_err());
    assert!(pending.is_dir());
}
#[test]
fn missing_pack_slot_does_not_advance_counter_and_refresh_recovers() {
    let f = Fixture::new();
    let mut grant = slots();
    fs::write(meta_dir(&f.0).join("slots.json"), serde_json::to_vec(&grant).unwrap()).unwrap();
    let error = PackWriter::new(&grant, &f.0).reserve().unwrap_err();
    assert_eq!(error_exit_code(&error), 76);
    assert!(!meta_dir(&f.0).join("pack.next").exists());
    grant.packs.insert("0".into(), "unused".into());
    fs::write(meta_dir(&f.0).join("slots.json"), serde_json::to_vec(&grant).unwrap()).unwrap();
    assert_eq!(PackWriter::new(&grant, &f.0).reserve().unwrap(), 0);
    assert_eq!(fs::read_to_string(meta_dir(&f.0).join("pack.next")).unwrap(), "1");
    fs::write(meta_dir(&f.0).join("pack.next"), "broken").unwrap();
    assert!(PackWriter::new(&grant, &f.0).reserve().is_err());
}
#[test]
fn heavy_subtrees_are_registered_for_mandatory_scans() {
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("node_modules/a/deep")).unwrap();
    let ino = inotify::Inotify::init().unwrap();
    let mut map = HashMap::new();
    let mut must_scan = HashSet::new();
    let mut overflow = false;
    add_watches(&mut ino.watches(), &mut map, &f.0, &f.0, &mut overflow, &mut must_scan);
    assert!(!overflow);
    assert!(must_scan.contains(&f.0.join("node_modules")));
    assert!(!map.values().any(|(path, _)| path.ends_with("deep")));
}

#[test]
fn failed_rebase_preserves_previous_local_watermark_and_chunk_index() {
    let f = Fixture::new();
    fs::write(meta_dir(&f.0).join("slots.json"), r#"{"volume":"v","attachment":"a","pack_prefix":"att/a/p/","manifest_prefix":"att/a/m/2/","packs":{},"manifests":{}}"#).unwrap();
    let mut st = State { volume: "v".into(), attachment: "a".into(), boot_id: boot_id(), seq: 10, ..State::default() };
    let mut old = entry(1); old.chunks.push(ChunkRef("id".into(), 1));
    st.entries.insert("replace".into(), old);
    st.have.insert("id".into(), ChunkLoc("att/a/m/1/10".into(), 16, 5, 1));
    let before = bincode::serialize(&st).unwrap();
    assert!(sync_once(&f.0, &mut st, Scope::Full, "rebase", Some(3)).is_err());
    assert_eq!(bincode::serialize(&st).unwrap(), before);
}

#[test]
fn pending_epoch_switch_refuses_replay_and_rebase_preserves_exact_old_bytes() {
    let f = Fixture::new(); let grant = slots();
    let journal = PendingJournal { manifest_key: "old-epoch/2".into(), body: b"immutable bytes".to_vec(), apply: apply() };
    let bytes = encode_pending(&journal).unwrap();
    let path = meta_dir(&f.0).join("pending.manifest"); fs::write(&path, &bytes).unwrap();
    let mut st = State { seq: 1, ..State::default() };
    let error = recover_pending(&f.0, &mut st, &grant).unwrap_err();
    assert!(error.to_string().contains("PENDING_EPOCH_MISMATCH"));
    assert_eq!(st.seq, 1); assert_eq!(fs::read(&path).unwrap(), bytes);
    quarantine_pending(&f.0).unwrap(); assert!(!path.exists());
    let archive = fs::read_dir(meta_dir(&f.0).join("recovery")).unwrap().next().unwrap().unwrap().path();
    assert_eq!(fs::read(archive).unwrap(), bytes);
}

#[test]
fn rebase_cache_pruning_preserves_final_references_and_undo_restores_all_old_locations() {
    let f=Fixture::new(); let mut st=State {seq:10,..State::default()};
    let mut kept=entry(1);kept.chunks=vec![ChunkRef("keep".into(),1)];
    let mut deleted=entry(1);deleted.chunks=vec![ChunkRef("orphan".into(),1)];
    st.entries.insert("keep-file".into(),kept);st.entries.insert("deleted".into(),deleted);
    for id in ["keep","orphan","unreferenced"] {st.have.insert(id.into(),ChunkLoc(format!("old/{id}"),0,1,1));}
    save_state(&f.0,&st).unwrap();let before=bincode::serialize(&st).unwrap();let logical_before=serde_json::to_value(&st).unwrap();
    let pending=|| {
        let mut new_entry=entry(1);new_entry.chunks=vec![ChunkRef("new".into(),1)];
        PendingApply {seq:4,rebase:true,next_pack:2,upserts:vec![("new-file".into(),new_entry)],deletes:vec!["deleted".into()],new_locs:[("keep".into(),ChunkLoc("new/keep".into(),0,1,1)),("new".into(),ChunkLoc("new/new".into(),0,1,1))].into_iter().collect(),unstable:vec![]}
    };
    FAIL_STATE_SAVE.with(|value|value.set(true));let result=commit_pending(&f.0,&mut st,pending());FAIL_STATE_SAVE.with(|value|value.set(false));
    assert_eq!(error_exit_code(&result.unwrap_err()),78);assert_eq!(serde_json::to_value(&st).unwrap(),logical_before);assert_eq!(fs::read(state_path(&f.0)).unwrap(),before);
    commit_pending(&f.0,&mut st,pending()).unwrap();assert_eq!(st.seq,4);assert_eq!(st.have.len(),2);
    assert_eq!(st.have["keep"].0,"new/keep");assert_eq!(st.have["new"].0,"new/new");
    assert!(!st.have.contains_key("orphan"));assert!(!st.have.contains_key("unreferenced"));
    assert_eq!(serde_json::to_value(load_state(&f.0).unwrap().unwrap()).unwrap(),serde_json::to_value(&st).unwrap());
}
