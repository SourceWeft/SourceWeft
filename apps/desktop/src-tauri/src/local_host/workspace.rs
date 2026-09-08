use super::{HostError, Result};
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
    pub path: PathBuf,
}

/// The database is outside the task filesystem. Workspace names are generated here,
/// never assembled from model-controlled paths, account IDs or conversation titles.
pub struct LocalHost {
    pub(crate) db: Mutex<Connection>,
    base: PathBuf,
}

impl LocalHost {
    pub fn open(app_data: &Path) -> Result<Self> {
        #[cfg(not(target_os = "macos"))]
        return Err(HostError::new(
            "UNSUPPORTED_PLATFORM",
            "Local execution currently requires macOS.",
        ));

        #[cfg(target_os = "macos")]
        {
            fs::create_dir_all(app_data)?;
            let base = app_data.canonicalize()?;
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
            let connection = Connection::open(db_path)?;
            connection.busy_timeout(std::time::Duration::from_secs(5))?;
            connection.execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
            )?;
            let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            if version > 2 {
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
            Ok(Self {
                db: Mutex::new(connection),
                base,
            })
        }
    }

    pub fn workspace_base(&self) -> PathBuf {
        self.base.join("task-workspaces")
    }

    /// Call on the first committed message, not when opening an empty chat view.
    /// The first transaction reserves an ID. Recovery can finish ONLY that allocation.
    pub fn ensure_workspace(&self, owner: &str, thread: &str) -> Result<Workspace> {
        validate_identity(owner)?;
        validate_identity(thread)?;
        let mut db = self
            .db
            .lock()
            .map_err(|_| HostError::new("HOST_UNAVAILABLE", "Workspace database lock failed."))?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
            let id = Uuid::new_v4().to_string();
            tx.execute("INSERT INTO workspaces(id,owner_id,thread_id,state) VALUES(?1,?2,?3,'provisioning')", params![id, owner, thread])?;
            (id, "provisioning".to_owned())
        };
        tx.commit()?;

        // A second immediate transaction serializes filesystem provisioning across
        // processes. The reservation above survives a crash before directory creation.
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: String =
            tx.query_row("SELECT state FROM workspaces WHERE id=?1", [&id], |row| {
                row.get(0)
            })?;

        let base = self.workspace_base();
        require_real_directory(&base)?;
        let allocation = base.join(&id);
        let root = allocation.join("files");
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
        private_dir(&root)?;
        // Persist directory entries before committing readiness.
        fs::File::open(&allocation)?.sync_all()?;
        fs::File::open(&base)?.sync_all()?;
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
        require_real_directory(&self.workspace_base())?;
        let allocation = self.workspace_base().join(id);
        require_real_directory(&allocation)?;
        let path = allocation.join("files");
        verify_root(&db, id, &path)?;
        Ok(Workspace {
            id: id.to_owned(),
            thread_id,
            path,
        })
    }
}

fn root_identity(path: &Path) -> Result<(u64, u64)> {
    require_real_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = path.symlink_metadata()?;
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    Err(HostError::new(
        "UNSUPPORTED_PLATFORM",
        "Workspace identity requires macOS.",
    ))
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
    require_real_directory(path)
}

fn require_real_directory(path: &Path) -> Result<()> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        _ => Err(HostError::new("WORKSPACE_MISSING", "The workspace directory is missing or was replaced. It will not be recreated automatically.")),
    }
}
