use super::readiness::ReadinessCache;
use super::{HostError, Result};
#[cfg(windows)]
use super::winpath;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub thread_id: String,
    /// Native form inside the host; serialized in the wire form (see `winpath`).
    #[serde(serialize_with = "serialize_wire_path")]
    pub path: PathBuf,
}

fn serialize_wire_path<S: serde::Serializer>(
    path: &Path,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    let wire = super::winpath::host_to_wire(path).map_err(serde::ser::Error::custom)?;
    serializer.serialize_str(&wire)
}

/// The folder, directly in the user's home directory, that holds automatic task folders unless
/// another location was chosen in settings.
pub const DEFAULT_TASK_FOLDER_NAME: &str = "SourceWeft";

/// Where automatic task folders are created (`LocalHost::task_folder`), in the wire form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFolder {
    pub path: String,
    /// `None` when this computer has no default location (its home directory is unavailable).
    pub default_path: Option<String>,
    pub is_default: bool,
}

/// The database is outside the task filesystem. Workspace names are generated here,
/// never assembled from model-controlled paths, account IDs or conversation titles.
pub struct LocalHost {
    pub admission: super::maintenance::Admission,
    pub(crate) db: Mutex<Connection>,
    pub(crate) binary_reads:
        Mutex<std::collections::HashMap<String, super::files::BinaryReadSession>>,
    // Widened from private so `readiness.rs` can locate the sandbox bundle directly under the
    // app-data base, without a single-purpose accessor method.
    pub(super) base: PathBuf,
    /// Where automatic task folders go unless settings name another location: a visible folder
    /// in the user's home directory. `None` when the host was opened without one; reserving a
    /// task folder then needs a location chosen in settings.
    default_task_base: Option<PathBuf>,
    // Caches `sandbox_readiness()`'s result; see `ReadinessCache`'s own doc comment in
    // readiness.rs for the policy. Present on every platform (only macOS and Linux read it) so
    // the struct's shape does not depend on target OS.
    pub(super) sandbox_readiness_cache: Mutex<ReadinessCache>,
    /// Relays sandbox network approvals to the backend over the device WebSocket
    /// (`remote_host.rs` installs the outbound channel while connected).
    pub network: super::network::NetworkBridge,
    // The sandbox sidecar (macOS, Linux) or the per-workspace sidecars (Windows), started lazily
    // on the first command; see `srt_exec.rs`.
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    pub(super) sandbox: super::srt_exec::SandboxSlot,
}

impl LocalHost {
    /// A host without a default task folder location. A conversation's automatic folder is then
    /// either the application-storage one (`ensure_workspace`) or under a location chosen with
    /// `set_task_folder`.
    pub fn open(app_data: &Path) -> Result<Self> {
        Self::open_with_task_folder(app_data, None)
    }

    /// `default_task_folder` is where automatic task folders go unless settings name another
    /// location (`<home>/SourceWeft` in the desktop app). It need not exist: it is created by the
    /// first task that uses it. Its parent must exist; otherwise the host has no default.
    pub fn open_with_task_folder(
        app_data: &Path,
        default_task_folder: Option<&Path>,
    ) -> Result<Self> {
        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        return Err(HostError::new(
            "UNSUPPORTED_PLATFORM",
            "Local execution currently requires macOS, Linux or Windows.",
        ));

        #[cfg(any(target_os = "macos", target_os = "linux", windows))]
        {
            fs::create_dir_all(app_data)?;
            let base = canonical_dir(app_data)?;
            for dir in [base.join("local-host"), base.join("task-workspaces")] {
                private_dir(&dir)?;
            }
            let db_path = base.join("local-host/state.sqlite3");
            if db_path
                .symlink_metadata()
                .is_ok_and(|meta| !meta.is_file() || meta.file_type().is_symlink())
            {
                return Err(HostError::new(
                    "UNSAFE_DATABASE_PATH",
                    "The local database must be a regular file.",
                ));
            }
            let mut connection = Connection::open(db_path)?;
            connection.busy_timeout(std::time::Duration::from_secs(5))?;
            connection.execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
            )?;
            let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            if version > 5 {
                return Err(HostError::new(
                    "DATABASE_VERSION_UNSUPPORTED",
                    "Update the desktop app before opening this database.",
                ));
            }
            if version == 0 {
                connection.execute_batch(
                    "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS workspaces (
                   id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, thread_id TEXT NOT NULL,
                   state TEXT NOT NULL CHECK (state IN ('provisioning','ready')),
                   root_device INTEGER, root_inode INTEGER,
                   UNIQUE(owner_id, thread_id));
                 PRAGMA user_version=2;
                 COMMIT;",
                )?;
            }
            if version == 1 {
                // Do not trust/backfill a replaced directory from an old journal.
                // Existing ready rows need explicit local recovery; new allocations work.
                connection.execute_batch(
                    "BEGIN IMMEDIATE;
                    ALTER TABLE workspaces ADD COLUMN root_device INTEGER;
                    ALTER TABLE workspaces ADD COLUMN root_inode INTEGER;
                    PRAGMA user_version=2; COMMIT;",
                )?;
            }
            if version < 4 {
                // Both released development branches used v3. Inspect columns before
                // upgrading, preserving their recorded root identities without adoption.
                let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let columns: Vec<String> = tx
                    .prepare("PRAGMA table_info(workspaces)")?
                    .query_map([], |r| r.get(1))?
                    .collect::<std::result::Result<_, _>>()?;
                tx.execute_batch("CREATE TABLE IF NOT EXISTS directory_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, path TEXT NOT NULL, root_device INTEGER NOT NULL, root_inode INTEGER NOT NULL);")?;
                for name in ["selected_path", "directory_grant_id"] {
                    if !columns.iter().any(|c| c == name) {
                        tx.execute_batch(&format!(
                            "ALTER TABLE workspaces ADD COLUMN {name} TEXT;"
                        ))?;
                    }
                }
                let legacy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='folder_grants')", [], |r| r.get(0))?;
                if legacy {
                    let conflicts: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM folder_grants f JOIN directory_grants d ON d.id=f.id WHERE f.owner_id IS NOT d.owner_id OR f.path IS NOT d.path OR f.root_device IS NOT d.root_device OR f.root_inode IS NOT d.root_inode)", [], |r| r.get(0))?;
                    if conflicts {
                        return Err(HostError::new(
                            "DIRECTORY_MIGRATION_CONFLICT",
                            "Directory grants need local recovery.",
                        ));
                    }
                    tx.execute_batch("INSERT OR IGNORE INTO directory_grants SELECT id,owner_id,path,root_device,root_inode FROM folder_grants;")?;
                }
                if columns.iter().any(|c| c == "attached_path")
                    && columns.iter().any(|c| c == "folder_id")
                {
                    let conflicts: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM workspaces WHERE (selected_path IS NOT NULL AND attached_path IS NOT NULL AND selected_path IS NOT attached_path) OR (directory_grant_id IS NOT NULL AND folder_id IS NOT NULL AND directory_grant_id IS NOT folder_id))", [], |r| r.get(0))?;
                    if conflicts {
                        return Err(HostError::new(
                            "DIRECTORY_MIGRATION_CONFLICT",
                            "Conversation bindings need local recovery.",
                        ));
                    }
                    tx.execute_batch("UPDATE workspaces SET selected_path=COALESCE(selected_path,attached_path),directory_grant_id=COALESCE(directory_grant_id,folder_id);")?;
                }
                tx.execute_batch("PRAGMA user_version=4;")?;
                tx.commit()?;
            }
            if version < 5 {
                // `root_path`: the files directory of an automatic workspace that lives in the
                // visible task folder. NULL for one in application storage and for a chosen
                // directory. `host_settings`: this computer's own settings.
                let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let columns: Vec<String> = tx
                    .prepare("PRAGMA table_info(workspaces)")?
                    .query_map([], |r| r.get(1))?
                    .collect::<std::result::Result<_, _>>()?;
                if !columns.iter().any(|c| c == "root_path") {
                    tx.execute_batch("ALTER TABLE workspaces ADD COLUMN root_path TEXT;")?;
                }
                tx.execute_batch(
                    "CREATE TABLE IF NOT EXISTS host_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                     PRAGMA user_version=5;",
                )?;
                tx.commit()?;
            }
            // Canonical parent plus the name, so the stored paths are canonical even though the
            // folder itself may not exist yet.
            let default_task_base = default_task_folder.and_then(|folder| {
                let parent = canonical_dir(folder.parent()?).ok()?;
                let candidate = parent.join(folder.file_name()?);
                (!paths_overlap(&base, &candidate)).then_some(candidate)
            });
            Ok(Self {
                admission: super::maintenance::Admission::default(),
                db: Mutex::new(connection),
                binary_reads: Mutex::new(std::collections::HashMap::new()),
                base,
                default_task_base,
                sandbox_readiness_cache: Mutex::new(ReadinessCache::default()),
                network: Default::default(),
                #[cfg(any(target_os = "macos", target_os = "linux", windows))]
                sandbox: Default::default(),
            })
        }
    }

    /// Never expose a path-taking version of this method to the WebView or model.
    pub fn grant_directory(&self, owner: &str, selected: &Path) -> Result<(String, PathBuf)> {
        validate_identity(owner)?;
        require_real_directory(selected)?;
        let path = canonical_dir(selected)?;
        // Too-broad first: the profile and AppData contain the application's own storage, and
        // "choose a narrower folder" is the useful answer for them.
        #[cfg(windows)]
        {
            let (profile, app_data_roots) = winpath::user_locations()?;
            winpath::refuse_broad_grant(&path, &profile, &app_data_roots)?;
        }
        if paths_overlap(&self.base, &path) {
            return Err(HostError::new(
                "DIRECTORY_DENIED",
                "Choose a task directory outside application storage.",
            ));
        }
        let (device, inode) = root_identity(&path)?;
        let id = Uuid::new_v4().to_string();
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Directory database lock failed."))?;
        db.execute("INSERT INTO directory_grants(id,owner_id,path,root_device,root_inode) VALUES(?1,?2,?3,?4,?5)", params![id,owner,db_path(&path)?,device,inode])?;
        Ok((id, path))
    }

    pub(crate) fn backup_base(&self) -> Result<PathBuf> {
        let path = self.base.join("local-host/backups");
        private_dir(&path)?;
        Ok(path)
    }

    pub fn register_folder(&self, owner: &str, path: &Path) -> Result<serde_json::Value> {
        let (id, path) = self.grant_directory(owner, path)?;
        Ok(
            serde_json::json!({"id":id,"path":super::winpath::host_to_wire(&path)?,"name":path.file_name().unwrap_or_default().to_string_lossy()}),
        )
    }

    pub(crate) fn granted_directory(&self, owner: &str, grant: &str) -> Result<PathBuf> {
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Directory database lock failed."))?;
        let selected: Option<(String, u64, u64)> = db.query_row(
            "SELECT path,root_device,root_inode FROM directory_grants WHERE id=?1 AND owner_id=?2",
            params![grant, owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        let (path, device, inode) = selected.ok_or_else(|| {
            HostError::new(
                "DIRECTORY_GRANT_DENIED",
                "The directory grant is unavailable.",
            )
        })?;
        let path = path_from_db(&path)?;
        self.check_selected_directory(&path)?;
        if root_identity(&path)? != (device, inode) {
            return Err(HostError::new(
                "WORKSPACE_REPLACED",
                "The selected directory was replaced.",
            ));
        }
        Ok(path)
    }

    /// The allocation store in application storage: one directory per automatic workspace,
    /// holding its ownership marker and, for workspaces that predate the visible task folder
    /// (or were created through a backend that does not reserve one), its `files` directory.
    pub fn workspace_base(&self) -> PathBuf {
        self.base.join("task-workspaces")
    }

    /// Where automatic task folders are created.
    pub fn task_folder(&self) -> Result<TaskFolder> {
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Settings database lock failed."))?;
        self.task_folder_with(&db)
    }

    /// Makes `selected` (an existing directory the user picked in the native dialog) the place
    /// new automatic task folders are created in. Existing conversations keep their folder.
    /// Never expose a path-taking version of this method to the WebView or model.
    pub fn set_task_folder(&self, selected: &Path) -> Result<TaskFolder> {
        require_real_directory(selected)?;
        let path = canonical_dir(selected)?;
        #[cfg(windows)]
        {
            let (profile, app_data_roots) = winpath::user_locations()?;
            winpath::refuse_broad_grant(&path, &profile, &app_data_roots)?;
        }
        self.check_selected_directory(&path)?;
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Settings database lock failed."))?;
        db.execute(
            "INSERT INTO host_settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![TASK_FOLDER_SETTING, db_path(&path)?],
        )?;
        self.task_folder_with(&db)
    }

    /// Returns to the default location. Existing conversations keep their folder.
    pub fn reset_task_folder(&self) -> Result<TaskFolder> {
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Settings database lock failed."))?;
        db.execute(
            "DELETE FROM host_settings WHERE key=?1",
            [TASK_FOLDER_SETTING],
        )?;
        self.task_folder_with(&db)
    }

    fn task_folder_with(&self, db: &Connection) -> Result<TaskFolder> {
        let base = self.task_base(db)?;
        Ok(TaskFolder {
            path: super::winpath::host_to_wire(&base)?,
            default_path: self
                .default_task_base
                .as_deref()
                .map(super::winpath::host_to_wire)
                .transpose()?,
            is_default: self.is_default_task_base(&base),
        })
    }

    fn is_default_task_base(&self, location: &Path) -> bool {
        self.default_task_base
            .as_deref()
            .is_some_and(|default| same_directory(default, location))
    }

    /// The location chosen in settings, else the default one.
    fn task_base(&self, db: &Connection) -> Result<PathBuf> {
        let chosen: Option<String> = db
            .query_row(
                "SELECT value FROM host_settings WHERE key=?1",
                [TASK_FOLDER_SETTING],
                |row| row.get(0),
            )
            .optional()?;
        match chosen {
            Some(stored) => path_from_db(&stored),
            None => self.default_task_base.clone().ok_or_else(|| {
                HostError::new(
                    "TASK_FOLDER_UNAVAILABLE",
                    "This computer has no default task folder. Choose one in settings.",
                )
            }),
        }
    }

    /// Whether `path` is a directory this host works in: the task folder location, a
    /// conversation's working directory, or a directory granted through the native picker.
    /// The file manager may be asked to show such a directory, and no other.
    pub fn is_known_directory(&self, path: &Path) -> Result<bool> {
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Directory database lock failed."))?;
        if self.task_base(&db).is_ok_and(|base| same_directory(&base, path)) {
            return Ok(true);
        }
        let mut known = Vec::new();
        for query in [
            "SELECT path FROM directory_grants",
            "SELECT selected_path FROM workspaces WHERE selected_path IS NOT NULL",
            "SELECT root_path FROM workspaces WHERE root_path IS NOT NULL",
        ] {
            let mut statement = db.prepare(query)?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            for stored in rows {
                known.push(path_from_db(&stored?)?);
            }
        }
        let mut statement = db.prepare(
            "SELECT id FROM workspaces WHERE selected_path IS NULL AND root_path IS NULL",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for id in rows {
            known.push(self.workspace_base().join(id?).join("files"));
        }
        Ok(known.iter().any(|candidate| same_directory(candidate, path)))
    }

    /// `workspace_base()` as the backend sees it (see `winpath`).
    pub fn workspace_base_wire(&self) -> Result<String> {
        super::winpath::host_to_wire(&self.workspace_base())
    }

    /// The sandbox sidecar's `init.workspaceRoots`: the allocation store, every task folder
    /// location that holds a conversation's folder, and every currently granted directory. Only
    /// those that exist (a missing one cannot be a workspace). The allocation store stays first:
    /// the sidecar probes with the first root.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn sandbox_workspace_roots(&self) -> Result<Vec<PathBuf>> {
        let mut roots = vec![self.workspace_base()];
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Directory database lock failed."))?;
        let mut statement = db.prepare(
            "SELECT DISTINCT root_path FROM workspaces WHERE root_path IS NOT NULL ORDER BY root_path",
        )?;
        let task_roots = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for root in task_roots {
            let root = path_from_db(&root)?;
            if let Some(location) = task_location(&root) {
                if location.is_dir() && !roots.iter().any(|known| known == location) {
                    roots.push(location.to_path_buf());
                }
            }
        }
        let mut statement =
            db.prepare("SELECT DISTINCT path FROM directory_grants ORDER BY path")?;
        let paths = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for path in paths {
            let path = path_from_db(&path)?;
            if path.is_dir() && !roots.contains(&path) {
                roots.push(path);
            }
        }
        Ok(roots)
    }

    /// Call on the first committed message, not when opening an empty chat view.
    /// The first transaction reserves an ID. Recovery can finish ONLY that allocation.
    pub fn ensure_workspace(&self, owner: &str, thread: &str) -> Result<Workspace> {
        self.ensure_workspace_with_grant(owner, thread, None)
    }

    /// This is called only with an opaque grant issued by the native picker.
    pub fn ensure_workspace_with_grant(
        &self,
        owner: &str,
        thread: &str,
        grant: Option<&str>,
    ) -> Result<Workspace> {
        self.ensure_bound_workspace(owner, thread, None, grant)
    }

    /// Decides where a conversation's automatic task folder will be, in the visible task
    /// folder location, and records it. Nothing is created on disk: the first
    /// `ensure_bound_workspace` creates the folder. Repeating the call returns the same answer,
    /// also for a conversation whose folder is in application storage.
    ///
    /// The folder is `<location>/<local date>/<start of the workspace ID>`: the name is
    /// generated here from the date and the ID alone.
    pub fn reserve_workspace(
        &self,
        owner: &str,
        thread: &str,
        requested_id: Option<&str>,
    ) -> Result<Workspace> {
        let requested = requested_id
            .map(|id| {
                Uuid::parse_str(id).map_err(|_| {
                    HostError::new("INVALID_WORKSPACE_ID", "Workspace ID must be a UUID.")
                })
            })
            .transpose()?;
        validate_identity(owner)?;
        validate_identity(thread)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Workspace database lock failed."))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        type Bound = (String, Option<String>, Option<String>, Option<String>);
        let bound: Option<Bound> = tx
            .query_row(
                "SELECT id,directory_grant_id,selected_path,root_path FROM workspaces WHERE owner_id=?1 AND thread_id=?2",
                params![owner, thread],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((id, grant, selected, root)) = bound {
            if requested_id.is_some_and(|requested| requested != id) {
                return Err(HostError::new(
                    "WORKSPACE_BINDING_IMMUTABLE",
                    "Conversation already uses another directory.",
                ));
            }
            if grant.is_some() || selected.is_some() {
                return Err(HostError::new(
                    "LOCAL_WORKSPACE_IMMUTABLE",
                    "The conversation directory cannot be changed.",
                ));
            }
            let path = match root {
                Some(root) => path_from_db(&root)?,
                None => self.workspace_base().join(&id).join("files"),
            };
            return Ok(Workspace {
                id,
                thread_id: thread.into(),
                path,
            });
        }
        let uuid = requested.unwrap_or_else(Uuid::new_v4);
        let id = requested_id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid.to_string());
        let day = self.task_base(&tx)?.join(local_date()?);
        let name = uuid.simple().to_string();
        // A longer name only when the short one is taken, by another conversation or on disk.
        let mut root = None;
        for length in [8, 12, name.len()] {
            let candidate = day.join(&name[..length]);
            let taken: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE root_path=?1)",
                [db_path(&candidate)?],
                |row| row.get(0),
            )?;
            if !taken && candidate.symlink_metadata().is_err() {
                root = Some(candidate);
                break;
            }
        }
        let root = root.ok_or_else(|| {
            HostError::new(
                "WORKSPACE_OWNERSHIP_MISMATCH",
                "The task folder for this conversation already exists; unknown files will not be adopted.",
            )
        })?;
        self.check_selected_directory(&root)?;
        tx.execute(
            "INSERT INTO workspaces(id,owner_id,thread_id,state,root_path) VALUES(?1,?2,?3,'provisioning',?4)",
            params![id, owner, thread, db_path(&root)?],
        )?;
        tx.commit()?;
        Ok(Workspace {
            id,
            thread_id: thread.into(),
            path: root,
        })
    }

    pub fn ensure_bound_workspace(
        &self,
        owner: &str,
        thread: &str,
        requested_id: Option<&str>,
        grant: Option<&str>,
    ) -> Result<Workspace> {
        if requested_id.is_some_and(|id| Uuid::parse_str(id).is_err()) {
            return Err(HostError::new(
                "INVALID_WORKSPACE_ID",
                "Workspace ID must be a UUID.",
            ));
        }
        validate_identity(owner)?;
        validate_identity(thread)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Workspace database lock failed."))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let bound: Option<(String, Option<String>, Option<String>)> = tx.query_row(
            "SELECT id,directory_grant_id,selected_path FROM workspaces WHERE owner_id=?1 AND thread_id=?2",
            params![owner,thread], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((id, previous_grant, selected_path)) = &bound {
            if requested_id.is_some_and(|requested| requested != id) {
                return Err(HostError::new(
                    "WORKSPACE_BINDING_IMMUTABLE",
                    "Conversation already uses another directory.",
                ));
            }
            if previous_grant.as_deref() != grant {
                return Err(HostError::new(
                    "LOCAL_WORKSPACE_IMMUTABLE",
                    "The conversation directory cannot be changed.",
                ));
            }
            if let Some(path) = selected_path {
                let path = path_from_db(path)?;
                self.check_selected_directory(&path)?;
                verify_root(&tx, id, &path)?;
                return Ok(Workspace {
                    id: id.clone(),
                    thread_id: thread.into(),
                    path,
                });
            }
        }
        if let Some(grant) = grant {
            let selected: Option<(String,u64,u64)> = tx.query_row(
                "SELECT path,root_device,root_inode FROM directory_grants WHERE id=?1 AND owner_id=?2",
                params![grant,owner], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let (path, device, inode) = selected.ok_or_else(|| {
                HostError::new(
                    "DIRECTORY_GRANT_DENIED",
                    "Choose a directory on this computer using the native picker.",
                )
            })?;
            let path = path_from_db(&path)?;
            self.check_selected_directory(&path)?;
            if root_identity(&path)? != (device, inode) {
                return Err(HostError::new(
                    "WORKSPACE_REPLACED",
                    "The selected directory was replaced.",
                ));
            }
            let id = requested_id
                .map(str::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            tx.execute("INSERT INTO workspaces(id,owner_id,thread_id,state,root_device,root_inode,selected_path,directory_grant_id) VALUES(?1,?2,?3,'ready',?4,?5,?6,?7)", params![id,owner,thread,device,inode,db_path(&path)?,grant])?;
            tx.commit()?;
            return Ok(Workspace {
                id,
                thread_id: thread.into(),
                path,
            });
        }
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT id,state FROM workspaces WHERE owner_id=?1 AND thread_id=?2",
                params![owner, thread],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (id, _) = if let Some(found) = existing {
            found
        } else {
            let id = requested_id
                .map(str::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            tx.execute("INSERT INTO workspaces(id,owner_id,thread_id,state) VALUES(?1,?2,?3,'provisioning')", params![id, owner, thread])?;
            (id, "provisioning".to_owned())
        };
        tx.commit()?;

        // A second immediate transaction serializes filesystem provisioning across
        // processes. The reservation above survives a crash before directory creation.
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (state, reserved): (String, Option<String>) = tx.query_row(
            "SELECT state,root_path FROM workspaces WHERE id=?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let base = self.workspace_base();
        require_real_directory(&base)?;
        let allocation = base.join(&id);
        // A reserved task folder (`reserve_workspace`) is in the visible location; the
        // allocation directory then holds only the ownership marker.
        let task_root = reserved.as_deref().map(path_from_db).transpose()?;
        if let Some(root) = &task_root {
            self.check_selected_directory(root)?;
        }
        let root = task_root
            .clone()
            .unwrap_or_else(|| allocation.join("files"));
        if state == "ready" {
            require_real_directory(&allocation)?;
            verify_root(&tx, &id, &root)?;
            return Ok(Workspace {
                id,
                thread_id: thread.to_owned(),
                path: root,
            });
        }

        // The allocation directory is trusted host metadata; only its files child
        // will ever be granted to a task. A task cannot remove its ownership marker.
        let created = match fs::create_dir(&allocation) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&allocation, fs::Permissions::from_mode(0o700))?;
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                require_real_directory(&allocation)?;
                false
            }
            Err(error) => return Err(error.into()),
        };
        let marker = allocation.join("owner.json");
        let expected = serde_json::to_vec(&(owner, thread, &id))
            .map_err(|e| HostError::new("SERIALIZATION_ERROR", e.to_string()))?;
        if !created && !marker.exists() {
            return Err(HostError::new("WORKSPACE_OWNERSHIP_MISMATCH", "An unmarked allocation requires local recovery; unknown files will not be adopted."));
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(&expected)?;
                file.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = marker.symlink_metadata()?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || fs::read(&marker)? != expected
                {
                    return Err(HostError::new(
                        "WORKSPACE_OWNERSHIP_MISMATCH",
                        "Workspace allocation belongs to a different owner or is incomplete.",
                    ));
                }
            }
            Err(error) => return Err(error.into()),
        }
        match &task_root {
            Some(root) => self.create_task_root(root)?,
            None => private_dir(&root)?,
        }
        // Persist directory entries before committing readiness.
        sync_directory(&allocation)?;
        sync_directory(&base)?;
        let (device, inode) = root_identity(&root)?;
        tx.execute(
            "UPDATE workspaces SET state='ready',root_device=?2,root_inode=?3 WHERE id=?1",
            params![id, device, inode],
        )?;
        tx.commit()?;
        Ok(Workspace {
            id,
            thread_id: thread.to_owned(),
            path: root,
        })
    }

    /// Creates a reserved task folder: the location (only the default one; a location chosen in
    /// settings must still exist), the date directory, and the folder itself. The folder may
    /// already exist only as the empty directory an interrupted earlier attempt left behind.
    fn create_task_root(&self, root: &Path) -> Result<()> {
        let (day, location) = root
            .parent()
            .and_then(|day| Some((day, day.parent()?)))
            .ok_or_else(|| HostError::new("INVALID_PATH", "The task folder path is incomplete."))?;
        if self.is_default_task_base(location) {
            private_dir(location)?;
        } else if require_real_directory(location).is_err() {
            return Err(HostError::new(
                "TASK_FOLDER_MISSING",
                "The task folder location is missing or was replaced. Choose a location in settings; it will not be recreated automatically.",
            ));
        }
        private_dir(day)?;
        match fs::create_dir(root) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                require_real_directory(root)?;
                if fs::read_dir(root)?.next().is_some() {
                    return Err(HostError::new(
                        "WORKSPACE_OWNERSHIP_MISMATCH",
                        "The task folder already contains files; unknown files will not be adopted.",
                    ));
                }
            }
            Err(error) => return Err(error.into()),
        }
        sync_directory(day)?;
        sync_directory(location)
    }

    /// Whether the folder of a reserved but not yet created task could be created: its location
    /// exists, or is the default one (created on first use) inside an existing directory.
    fn check_task_location(&self, root: &Path) -> Result<()> {
        let location = task_location(root)
            .ok_or_else(|| HostError::new("INVALID_PATH", "The task folder path is incomplete."))?;
        if location.symlink_metadata().is_err() && self.is_default_task_base(location) {
            let home = location.parent().ok_or_else(|| {
                HostError::new("INVALID_PATH", "The task folder path is incomplete.")
            })?;
            require_real_directory(home)?;
            fs::read_dir(home)?;
            return Ok(());
        }
        if require_real_directory(location).is_err() {
            return Err(HostError::new(
                "TASK_FOLDER_MISSING",
                "The task folder location is missing or was replaced. Choose a location in settings; it will not be recreated automatically.",
            ));
        }
        fs::read_dir(location)?;
        Ok(())
    }

    fn check_selected_directory(&self, path: &Path) -> Result<()> {
        if paths_overlap(&self.base, path) {
            return Err(HostError::new(
                "DIRECTORY_DENIED",
                "Choose a task directory outside application storage.",
            ));
        }
        Ok(())
    }

    pub fn check_workspace(
        &self,
        owner: &str,
        thread: &str,
        requested_id: Option<&str>,
        grant: Option<&str>,
    ) -> Result<()> {
        validate_identity(owner)?;
        validate_identity(thread)?;
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Workspace database lock failed."))?;
        type Bound = (String, Option<String>, String, Option<String>);
        let bound: Option<Bound> = db
            .query_row(
                "SELECT id,directory_grant_id,state,root_path FROM workspaces WHERE owner_id=?1 AND thread_id=?2",
                params![owner, thread],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((id, previous_grant, state, reserved)) = bound {
            if requested_id.is_some_and(|value| value != id) || previous_grant.as_deref() != grant {
                return Err(HostError::new(
                    "WORKSPACE_BINDING_IMMUTABLE",
                    "The working directory binding changed.",
                ));
            }
            if state != "ready" {
                // Reserved, not created yet: the first real operation creates it. Checking
                // availability must not.
                return match reserved {
                    Some(root) => self.check_task_location(&path_from_db(&root)?),
                    None => {
                        require_real_directory(&self.workspace_base())?;
                        fs::read_dir(self.workspace_base())?;
                        Ok(())
                    }
                };
            }
            drop(db);
            let workspace = self.get_workspace(owner, thread, &id)?;
            fs::read_dir(&workspace.path)?;
            return Ok(());
        }
        if let Some(grant) = grant {
            let selected: Option<(String, u64, u64)> = db.query_row(
                "SELECT path,root_device,root_inode FROM directory_grants WHERE id=?1 AND owner_id=?2",
                params![grant, owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
            let (path, device, inode) = selected.ok_or_else(|| {
                HostError::new(
                    "DIRECTORY_GRANT_DENIED",
                    "The directory grant is unavailable.",
                )
            })?;
            let path = path_from_db(&path)?;
            self.check_selected_directory(&path)?;
            if root_identity(&path)? != (device, inode) {
                return Err(HostError::new(
                    "WORKSPACE_REPLACED",
                    "The selected directory was replaced.",
                ));
            }
            fs::read_dir(&path)?;
        } else {
            // A never-initialized automatic workspace may be allocated by the first
            // real operation. Checking availability must not create it.
            require_real_directory(&self.workspace_base())?;
            fs::read_dir(self.workspace_base())?;
        }
        Ok(())
    }

    pub fn get_workspace(&self, owner: &str, thread: &str, id: &str) -> Result<Workspace> {
        let db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Workspace database lock failed."))?;
        let thread: Option<String> = db
            .query_row(
                "SELECT thread_id FROM workspaces WHERE owner_id=?1 AND id=?2 AND thread_id=?3 AND state='ready'",
                params![owner, id, thread],
                |r| r.get(0),
            )
            .optional()?;
        let thread_id = thread.ok_or_else(|| {
            HostError::new(
                "WORKSPACE_NOT_FOUND",
                "No workspace is authorized for this account.",
            )
        })?;
        let (selected, reserved): (Option<String>, Option<String>) = db.query_row(
            "SELECT selected_path,root_path FROM workspaces WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if let Some(selected) = selected {
            let path = path_from_db(&selected)?;
            self.check_selected_directory(&path)?;
            verify_root(&db, id, &path)?;
            return Ok(Workspace {
                id: id.into(),
                thread_id,
                path,
            });
        }
        require_real_directory(&self.workspace_base())?;
        let allocation = self.workspace_base().join(id);
        require_real_directory(&allocation)?;
        let path = match reserved {
            Some(root) => {
                let root = path_from_db(&root)?;
                self.check_selected_directory(&root)?;
                root
            }
            None => allocation.join("files"),
        };
        verify_root(&db, id, &path)?;
        Ok(Workspace {
            id: id.to_owned(),
            thread_id,
            path,
        })
    }
}

const TASK_FOLDER_SETTING: &str = "task_folder";

/// The task folder location a reserved root (`<location>/<date>/<name>`) lies in.
fn task_location(root: &Path) -> Option<&Path> {
    root.parent()?.parent()
}

/// Whether two paths name the same directory. Case-insensitive on Windows.
fn same_directory(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        winpath::same_path(a, b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Today's date in the computer's own time zone, as `YYYY-MM-DD`.
fn local_date() -> Result<String> {
    #[cfg(unix)]
    {
        let unavailable =
            || HostError::new("LOCAL_TIME_UNAVAILABLE", "The local date could not be determined.");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| unavailable())?
            .as_secs() as libc::time_t;
        // SAFETY: `localtime_r` writes only the `tm` it is given and reads only `now`.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        if unsafe { libc::localtime_r(&now, &mut tm) }.is_null() {
            return Err(unavailable());
        }
        Ok(format!(
            "{:04}-{:02}-{:02}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday
        ))
    }
    #[cfg(windows)]
    {
        // SAFETY: `GetLocalTime` only writes the `SYSTEMTIME` it is given and cannot fail.
        let mut now: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut now) };
        Ok(format!("{:04}-{:02}-{:02}", now.wYear, now.wMonth, now.wDay))
    }
    #[cfg(not(any(unix, windows)))]
    Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "The local date requires macOS, Linux or Windows.",
    ))
}

/// The directory's identity as stored in the `root_device`/`root_inode` columns. Unix: the real
/// device and inode numbers. Windows: the low 63 bits of SHA-256 hashes over the volume serial
/// number and the 128-bit file id (see `winpath::hash_identity`); a file system without stable
/// file ids (FAT, exFAT) is refused rather than guessed at.
fn root_identity(path: &Path) -> Result<(u64, u64)> {
    require_real_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = path.symlink_metadata()?;
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        let (serial, file_id) = winpath::file_identity(path).map_err(|error| {
            HostError::new(
                "WORKSPACE_IDENTITY_UNAVAILABLE",
                format!(
                    "This folder's file system does not provide a stable directory identity \
                     (NTFS and ReFS do): {error}"
                ),
            )
        })?;
        Ok(winpath::hash_identity(serial, file_id))
    }
    #[cfg(not(any(unix, windows)))]
    Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "Workspace identity requires macOS, Linux or Windows.",
    ))
}

/// The canonical absolute form of an existing directory. On Windows `canonicalize` yields a
/// verbatim `\\?\C:\...` path; it is converted to the native `C:\...` form (network paths and
/// names Win32 cannot spell are errors), so everything the host derives from it is non-verbatim.
fn canonical_dir(path: &Path) -> Result<PathBuf> {
    let canonical = path.canonicalize()?;
    #[cfg(windows)]
    {
        winpath::to_native(&canonical)
    }
    #[cfg(not(windows))]
    {
        Ok(canonical)
    }
}

/// Whether one path lies inside the other (or they are equal). Case-insensitive on Windows.
fn paths_overlap(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        winpath::is_inside(a, b) || winpath::is_inside(b, a)
    }
    #[cfg(not(windows))]
    {
        a.starts_with(b) || b.starts_with(a)
    }
}

/// A path as stored in the `path`/`selected_path` columns: the wire form on Windows (so the
/// database holds exactly what the backend sees), the plain string elsewhere.
fn db_path(path: &Path) -> Result<String> {
    #[cfg(windows)]
    {
        winpath::to_wire(path)
    }
    #[cfg(not(windows))]
    {
        Ok(path.to_string_lossy().into_owned())
    }
}

fn path_from_db(stored: &str) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        winpath::from_wire(stored)
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from(stored))
    }
}

/// Persists a directory's entries. Windows cannot flush a directory handle the way POSIX can
/// (NTFS journals its metadata); the file contents are flushed where they are written.
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::File::open(path)?.sync_all()?;
        Ok(())
    }
}

fn verify_root(db: &Connection, id: &str, path: &Path) -> Result<()> {
    let actual = root_identity(path)?;
    let expected: (Option<u64>, Option<u64>) = db.query_row(
        "SELECT root_device,root_inode FROM workspaces WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if expected != (Some(actual.0), Some(actual.1)) {
        return Err(HostError::new(
            "WORKSPACE_REPLACED",
            "The original workspace identity cannot be verified. Local recovery is required.",
        ));
    }
    Ok(())
}

fn validate_identity(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(HostError::new(
            "INVALID_IDENTITY",
            "Account and thread IDs must be non-empty bounded identifiers.",
        ));
    }
    Ok(())
}

fn private_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    // Windows has no mode bits: the directory inherits the ACL of the user's app-data folder.
    #[cfg(not(unix))]
    {
        match fs::create_dir(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    require_real_directory(path)
}

fn require_real_directory(path: &Path) -> Result<()> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        _ => Err(HostError::new("WORKSPACE_MISSING", "The workspace directory is missing or was replaced. It will not be recreated automatically.")),
    }
}
