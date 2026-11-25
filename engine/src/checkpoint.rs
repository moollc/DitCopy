use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn current_version() -> u32 {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    #[serde(default = "current_version")]
    pub version: u32,
    #[serde(default)]
    pub completed: BTreeMap<String, CompletedEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompletedEntry {
    pub bytes: u64,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub source_mtime_ns: Option<u128>,
    #[serde(default)]
    pub destinations: Vec<String>,
}

impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            version: current_version(),
            completed: BTreeMap::new(),
        }
    }
}

impl Checkpoint {
    /// Remove only DitCopy temporary files belonging to this checkpoint.
    pub fn clean_stale_temps(path: &Path) -> Result<usize> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("checkpoint path has no file name: {}", path.display()))?
            .to_string_lossy();
        let prefix = format!("{name}.tmp-");
        let mut removed = 0;
        let entries = match fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("read checkpoint folder {}", parent.display()));
            }
        };
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry.file_name().to_string_lossy().starts_with(&prefix)
            {
                fs::remove_file(entry.path()).with_context(|| {
                    format!("remove stale checkpoint temp {}", entry.path().display())
                })?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = fs::read_to_string(path)
            .with_context(|| format!("read checkpoint {}", path.display()))?;
        let cp: Checkpoint = serde_json::from_str(&text)
            .with_context(|| format!("parse checkpoint {}", path.display()))?;
        if cp.version > current_version() {
            anyhow::bail!("unsupported checkpoint version {}", cp.version);
        }
        Ok(cp)
    }

    /// Replace a checkpoint atomically. Only the engine calls this method.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)
                .with_context(|| format!("mkdir checkpoint parent {}", parent.display()))?;
        }
        let text = serde_json::to_vec_pretty(self).context("serialize checkpoint")?;
        let temp = temp_path(path);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create checkpoint temp {}", temp.display()))?;
        file.write_all(&text)
            .with_context(|| format!("write checkpoint temp {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("sync checkpoint temp {}", temp.display()))?;
        drop(file);
        fs::rename(&temp, path)
            .with_context(|| format!("replace checkpoint {}", path.display()))?;
        // Making the rename durable needs a sync of the folder. Windows cannot open a folder as a file, and its
        // rename already writes through, so this step is Unix only.
        #[cfg(unix)]
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            File::open(parent)
                .and_then(|dir| dir.sync_all())
                .with_context(|| format!("sync checkpoint directory {}", parent.display()))?;
        }
        Ok(())
    }

    pub fn entry(&self, rel: &str) -> Option<&CompletedEntry> {
        self.completed.get(rel)
    }

    pub fn mark_done(
        &mut self,
        rel: &str,
        bytes: u64,
        hash: &str,
        source_mtime_ns: Option<u128>,
        destinations: &[String],
    ) {
        self.completed.insert(
            rel.to_string(),
            CompletedEntry {
                bytes,
                hash: hash.to_string(),
                source_mtime_ns,
                destinations: destinations.to_vec(),
            },
        );
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".tmp-{}-{stamp}", std::process::id()));
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ditcopy-checkpoint-{name}-{stamp}.json"))
    }

    #[test]
    fn atomic_checkpoint_round_trips_resume_metadata() {
        let path = test_path("roundtrip");
        let mut cp = Checkpoint::default();
        cp.mark_done(
            "src/a.mov",
            4,
            "abcd",
            Some(123),
            &["/tmp/dest/src/a.mov".into()],
        );
        cp.save(&path).unwrap();
        let loaded = Checkpoint::load(&path).unwrap();
        let entry = loaded.entry("src/a.mov").unwrap();
        assert_eq!(entry.bytes, 4);
        assert_eq!(entry.hash, "abcd");
        assert_eq!(entry.source_mtime_ns, Some(123));
        assert_eq!(entry.destinations, ["/tmp/dest/src/a.mov"]);
    }

    #[test]
    fn old_entries_load_but_lack_authorization_metadata() {
        let path = test_path("legacy");
        fs::write(&path, r#"{"completed":{"a":{"bytes":4,"hash":"abcd"}}}"#).unwrap();
        let loaded = Checkpoint::load(&path).unwrap();
        let entry = loaded.entry("a").unwrap();
        assert_eq!(entry.source_mtime_ns, None);
        assert!(entry.destinations.is_empty());
    }

    #[test]
    fn startup_removes_only_temps_for_the_selected_checkpoint() {
        let path = test_path("cleanup");
        let stale = PathBuf::from(format!("{}.tmp-123-456", path.display()));
        let other = PathBuf::from(format!(
            "{}.tmp-123-456",
            path.with_file_name("other.json").display()
        ));
        fs::write(&stale, "stale").unwrap();
        fs::write(&other, "other checkpoint").unwrap();
        assert_eq!(Checkpoint::clean_stale_temps(&path).unwrap(), 1);
        assert!(!stale.exists());
        assert!(other.exists());
    }

    #[test]
    fn startup_treats_a_missing_checkpoint_folder_as_nothing_to_clean() {
        let dir = test_path("missing-folder")
            .with_extension("")
            .join("nested")
            .join("checkpoint.json");
        assert_eq!(Checkpoint::clean_stale_temps(&dir).unwrap(), 0);
        Checkpoint::default().save(&dir).unwrap();
        assert!(dir.exists());
    }
}
