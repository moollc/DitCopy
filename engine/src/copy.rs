#[cfg(all(feature = "test-hooks", not(debug_assertions)))]
compile_error!("test-hooks must never be enabled in release builds");
#[cfg(all(feature = "test-hooks", debug_assertions))]
mod test_writer;
use crate::events::Phase;
use crate::filters::rel_forward;
use crate::hash::{CHUNK_SIZE, HashAlgo, StreamingHasher, hash_file_phase};
use anyhow::{Context, Result, anyhow};
use clap::ValueEnum;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs::{self, File, FileTimes, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use walkdir::WalkDir;

pub const MTIME_SLACK_SECS: u64 = 2;

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq, Default)]
pub enum CopyMode {
    #[default]
    Force,
    Noexist,
    Diff,
    Newer,
    Sync,
    Move,
    Delete,
    VerifyOnly,
}

impl CopyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CopyMode::Force => "force",
            CopyMode::Noexist => "noexist",
            CopyMode::Diff => "diff",
            CopyMode::Newer => "newer",
            CopyMode::Sync => "sync",
            CopyMode::Move => "move",
            CopyMode::Delete => "delete",
            CopyMode::VerifyOnly => "verify-only",
        }
    }

    pub fn requires_confirm(self) -> bool {
        matches!(self, CopyMode::Sync | CopyMode::Move | CopyMode::Delete)
    }
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq, Default)]
pub enum SpeedMode {
    #[default]
    Full,
    Autoslow,
    #[value(name = "90")]
    P90,
    #[value(name = "50")]
    P50,
    #[value(name = "10")]
    P10,
}

impl SpeedMode {
    /// Target throughput fraction of unthrottled (1.0 = full).
    pub fn fraction(self) -> Option<f64> {
        match self {
            SpeedMode::Full => None,
            SpeedMode::Autoslow => Some(0.50),
            SpeedMode::P90 => Some(0.90),
            SpeedMode::P50 => Some(0.50),
            SpeedMode::P10 => Some(0.10),
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq, Default)]
pub enum DiskMode {
    #[default]
    Auto,
    Same,
    Diff,
}

pub struct PlannedFile {
    pub src: PathBuf,
    pub rel: PathBuf,
    pub size: u64,
}

pub fn collect_files(sources: &[PathBuf]) -> Result<Vec<PlannedFile>> {
    let mut out = Vec::new();
    for src in sources {
        let src = fs::canonicalize(src).unwrap_or_else(|_| src.clone());
        let meta = fs::metadata(&src).with_context(|| format!("stat source {}", src.display()))?;
        if meta.is_file() {
            let name = src
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("file"));
            out.push(PlannedFile {
                src: src.clone(),
                rel: name,
                size: meta.len(),
            });
        } else if meta.is_dir() {
            let basename = src
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("src"));
            for entry in WalkDir::new(&src).follow_links(false) {
                let entry = entry.with_context(|| format!("walk {}", src.display()))?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path().to_path_buf();
                let rel_under = path
                    .strip_prefix(&src)
                    .unwrap_or(entry.path())
                    .to_path_buf();
                let rel = basename.join(rel_under);
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(PlannedFile {
                    src: path,
                    rel,
                    size,
                });
            }
        } else {
            return Err(anyhow!("unsupported source type: {}", src.display()));
        }
    }
    Ok(out)
}

pub fn dest_path(dest_root: &Path, rel: &Path) -> PathBuf {
    dest_root.join(rel)
}

pub fn mtime_secs(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Skip decision for modes that may avoid rewriting an existing dest.
pub fn should_skip(mode: CopyMode, dest: &Path, src_size: u64, src_mtime: Option<u64>) -> bool {
    match mode {
        CopyMode::Force | CopyMode::VerifyOnly | CopyMode::Move | CopyMode::Delete => false,
        CopyMode::Noexist => dest.exists(),
        CopyMode::Diff | CopyMode::Sync => {
            if !dest.exists() {
                return false;
            }
            let Ok(meta) = fs::metadata(dest) else {
                return false;
            };
            if meta.len() != src_size {
                return false;
            }
            match (mtime_secs(dest), src_mtime) {
                (Some(dm), Some(sm)) => dm.abs_diff(sm) <= MTIME_SLACK_SECS,
                _ => false,
            }
        }
        CopyMode::Newer => {
            if !dest.exists() {
                return false;
            }
            match (mtime_secs(dest), src_mtime) {
                (Some(dm), Some(sm)) => {
                    // Skip when src is not newer than dest (+ slack)
                    sm <= dm + MTIME_SLACK_SECS
                }
                _ => false,
            }
        }
    }
}

pub fn preserve_mtime(dest: &Path, src_mtime: SystemTime) -> Result<()> {
    let file = File::options()
        .write(true)
        .open(dest)
        .with_context(|| format!("open for times {}", dest.display()))?;
    let times = FileTimes::new().set_modified(src_mtime);
    file.set_times(times)
        .with_context(|| format!("set mtime {}", dest.display()))?;
    Ok(())
}

/// True only when the operating system proves that no process has this id. Anything unknown or inaccessible counts as alive,
/// so a partial file that might still be written is never removed.
#[cfg(unix)]
fn process_is_gone(pid: u32) -> bool {
    // EPERM means alive but inaccessible. Only ESRCH proves no such process.
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_is_gone(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // No such process id. Access denied means it exists.
            return GetLastError() == ERROR_INVALID_PARAMETER;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code != STILL_ACTIVE
    }
}

fn partial_identity(path: &Path) -> Option<(String, u32)> {
    let text = path.file_name()?.to_str()?.strip_prefix('.')?;
    let (name, tail) = text.rsplit_once(".ditcopy-")?;
    let (pid, sequence) = tail.strip_suffix(".partial")?.split_once('-')?;
    if name.is_empty() || sequence.is_empty() || !sequence.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let pid_text = pid;
    let pid: u32 = pid.parse().ok()?;
    if pid == 0 || pid > i32::MAX as u32 || pid.to_string() != pid_text {
        return None;
    }
    Some((name.to_string(), pid))
}
fn published_path(path: &Path) -> PathBuf {
    partial_identity(path).map_or_else(|| path.to_path_buf(), |(name, _)| path.with_file_name(name))
}
fn clean_stale_partials(dest: &Path, opts: &CopyOptions<'_>) -> std::io::Result<Vec<PathBuf>> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let candidates = {
        let mut runtime = opts.runtime.borrow_mut();
        if !runtime.partial_candidates.contains_key(parent) {
            let mut names: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
            for entry in fs::read_dir(parent)? {
                let entry = entry?;
                if let Some((name, _)) = partial_identity(&entry.path())
                    && entry.file_type()?.is_file()
                {
                    names.entry(name).or_default().push(entry.path());
                }
            }
            runtime
                .partial_candidates
                .insert(parent.to_path_buf(), names);
        }
        runtime
            .partial_candidates
            .get_mut(parent)
            .unwrap()
            .remove(
                &dest
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
            )
            .unwrap_or_default()
    };
    let mut removed = Vec::new();
    for path in candidates {
        let Some((_, pid)) = partial_identity(&path) else {
            continue;
        };
        // EPERM means alive but inaccessible. Only ESRCH proves no such process.
        if process_is_gone(pid) {
            match fs::remove_file(&path) {
                Ok(()) => removed.push(path),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => crate::events::emit(&serde_json::json!({
                    "type":"partial_cleanup_warning", "destination":root_for_path(dest, opts.dests),
                    "file":dest, "path":path, "message":format!("Stale partial not removed: {e}")
                })),
            }
        }
    }
    Ok(removed)
}

pub fn rename_verify_err(dest: &Path) {
    let err_path = {
        let mut s = published_path(dest).as_os_str().to_owned();
        s.push(".ditcopy_verify_err");
        PathBuf::from(s)
    };
    let _ = fs::rename(dest, &err_path);
}

fn throttle_sleep(speed: SpeedMode, chunk_elapsed: Duration) {
    let Some(frac) = speed.fraction() else {
        return;
    };
    if frac <= 0.0 || frac >= 1.0 {
        return;
    }
    // Spend (1/frac) of wall time writing ⇒ sleep = elapsed * (1-frac)/frac
    let sleep_ns = (chunk_elapsed.as_secs_f64() * (1.0 - frac) / frac * 1_000_000_000.0) as u64;
    if sleep_ns > 0 {
        thread::sleep(Duration::from_nanos(sleep_ns));
    }
}

pub enum FileOutcome {
    Copied {
        bytes: u64,
        hash: String,
        destinations: Vec<PathBuf>,
    },
    Skipped {
        bytes: u64,
        hash: String,
    },
    Verified {
        bytes: u64,
        hash: String,
        destinations: Vec<PathBuf>,
    },
    Deleted {
        bytes: u64,
    },
}

#[derive(Debug)]
pub struct DestinationError(pub String);
impl std::fmt::Display for DestinationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for DestinationError {}

#[derive(Default)]
pub struct CopyRuntime {
    queue_reported: bool,
    cooldown: Arc<Mutex<BTreeMap<PathBuf, Cooldown>>>,
    preallocation_warned: HashSet<PathBuf>,
    partial_candidates: BTreeMap<PathBuf, BTreeMap<String, Vec<PathBuf>>>,
}
#[derive(Default)]
struct Cooldown {
    baseline: Option<f64>,
    baseline_bytes: u64,
    baseline_seconds: f64,
    since_check: u64,
    total_bytes: u64,
    recent: VecDeque<(u64, f64)>,
}
impl Cooldown {
    fn observe(
        &mut self,
        bytes: u64,
        elapsed: Duration,
        interval: u64,
        drop: u8,
    ) -> Option<(f64, f64)> {
        let seconds = elapsed.as_secs_f64().max(0.000001);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.since_check = self.since_check.saturating_add(bytes);
        self.recent.push_back((bytes, seconds));
        while self.recent.len() > 64
            || (self.recent.len() > 1
                && self.recent.iter().skip(1).map(|v| v.1).sum::<f64>() >= 5.0)
        {
            self.recent.pop_front();
        }
        if self.baseline.is_none() {
            self.baseline_bytes += bytes;
            self.baseline_seconds += seconds;
            if self.baseline_bytes >= 64 * 1024 * 1024 {
                self.baseline = Some(self.baseline_bytes as f64 / self.baseline_seconds);
            }
            return None;
        }
        if interval == 0 || self.since_check < interval {
            return None;
        }
        self.since_check %= interval;
        let current = self.recent.iter().map(|v| v.0 as f64).sum::<f64>()
            / self.recent.iter().map(|v| v.1).sum::<f64>();
        let baseline = self.baseline.unwrap();
        if current < baseline * (1.0 - f64::from(drop.min(99)) / 100.0) {
            self.recent.clear();
            Some((current, baseline))
        } else {
            None
        }
    }
}

pub struct CopyOptions<'a> {
    pub runtime: Rc<RefCell<CopyRuntime>>,
    pub writer_buffer_mib: u64,
    pub writer_total_buffer_mib: u64,
    pub nonstop: bool,
    pub failures: &'a RefCell<BTreeMap<PathBuf, String>>,
    pub mode: CopyMode,
    pub dests: &'a [PathBuf],
    pub verify: bool,
    pub perfect_verify: bool,
    pub hash_algo: HashAlgo,
    pub speed: SpeedMode,
    pub disk_mode: DiskMode,
    pub cooldown_seconds: u64,
    pub cooldown_every_gb: u64,
    pub cooldown_drop_percent: u8,
}

impl CopyOptions<'_> {
    pub fn healthy_roots(&self) -> Vec<PathBuf> {
        self.dests
            .iter()
            .filter(|r| !self.failures.borrow().contains_key(*r))
            .cloned()
            .collect()
    }
    fn failed(&self, dest: &Path) -> bool {
        self.failures
            .borrow()
            .contains_key(root_for_path(dest, self.dests))
    }
    fn fail(&self, dest: &Path, message: String) -> Result<()> {
        let root = root_for_path(dest, self.dests);
        let fresh = !self.failures.borrow().contains_key(root);
        self.failures
            .borrow_mut()
            .entry(root.to_path_buf())
            .or_insert_with(|| message.clone());
        crate::events::destination_failed(root, message.clone());
        if fresh {
            crate::events::emit(
                &serde_json::json!({"type":"destination_error","destination":root,"message":message,"status":"failed"}),
            );
        }
        if self.nonstop {
            Ok(())
        } else {
            Err(DestinationError(message).into())
        }
    }
}

pub fn copy_one_file(planned: &PlannedFile, opts: &CopyOptions<'_>) -> Result<FileOutcome> {
    let src_meta =
        fs::metadata(&planned.src).with_context(|| format!("stat {}", planned.src.display()))?;
    let src_mtime = src_meta.modified().ok();
    let src_mtime_secs = src_mtime
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    if opts.mode == CopyMode::Delete {
        fs::remove_file(&planned.src)
            .with_context(|| format!("delete source {}", planned.src.display()))?;
        return Ok(FileOutcome::Deleted {
            bytes: planned.size,
        });
    }
    if opts.healthy_roots().is_empty() {
        return Err(DestinationError("no destinations remain".into()).into());
    }
    let mut active_dests = Vec::new();
    for root in opts.dests {
        if opts.failed(root) {
            continue;
        }
        let dest = dest_path(root, &planned.rel);
        if opts.mode == CopyMode::VerifyOnly
            || !should_skip(opts.mode, &dest, planned.size, src_mtime_secs)
        {
            active_dests.push(dest);
        }
    }
    if active_dests.is_empty() {
        let (hash, bytes) = hash_file_phase(
            &planned.src,
            opts.hash_algo,
            "hashing_skipped_source",
            &planned.src,
            None,
            planned.size,
        )?;
        return Ok(FileOutcome::Skipped { bytes, hash });
    }
    if opts.mode == CopyMode::VerifyOnly {
        return verify_only_file(planned, &active_dests, opts);
    }
    let mut ready = Vec::new();
    for dest in active_dests {
        if let Some(parent) = dest.parent()
            && let Err(e) = fs::create_dir_all(parent)
        {
            opts.fail(&dest, format!("mkdir {}: {e}", parent.display()))?;
            continue;
        }
        match clean_stale_partials(&dest, opts) {
            Ok(paths) => {
                for path in paths {
                    crate::events::emit(
                        &serde_json::json!({"type":"partial_cleanup","destination":root_for_path(&dest, opts.dests),"file":dest,"path":path}),
                    );
                }
            }
            Err(e) => {
                crate::events::emit(&serde_json::json!({
                    "type":"partial_cleanup_warning", "destination":root_for_path(&dest, opts.dests),
                    "file":dest, "path":dest.parent(), "message":format!("Cannot inspect stale partials: {e}")
                }));
            }
        }
        crate::events::destination_begin(root_for_path(&dest, opts.dests));
        ready.push(dest);
    }
    if ready.is_empty() {
        return Err(DestinationError("no destinations remain after mkdir".into()).into());
    }
    // Unique sibling names keep interrupted copies away from final filenames.
    static NEXT_PARTIAL: AtomicU64 = AtomicU64::new(0);
    let pending: Vec<(PathBuf, PathBuf)> = ready
        .iter()
        .map(|dest| {
            let name = dest.file_name().unwrap_or_default().to_string_lossy();
            let temp = dest.with_file_name(format!(
                ".{name}.ditcopy-{}-{}.partial",
                std::process::id(),
                NEXT_PARTIAL.fetch_add(1, Ordering::Relaxed)
            ));
            (dest.clone(), temp)
        })
        .collect();
    let temporary: Vec<PathBuf> = pending.iter().map(|(_, temp)| temp.clone()).collect();
    let (hash, total) = if matches!(opts.disk_mode, DiskMode::Same) {
        copy_same_disk(planned, &temporary, opts)?
    } else {
        copy_chunk_fanout(planned, &temporary, opts)?
    };
    if total != planned.size {
        return Err(anyhow!(
            "source size changed while copying {}",
            planned.src.display()
        ));
    }
    let written: Vec<PathBuf> = temporary.into_iter().filter(|d| !opts.failed(d)).collect();
    for temp in &written {
        crate::events::destination_copied(root_for_path(temp, opts.dests));
        if let Some(mtime) = src_mtime
            && let Err(e) = preserve_mtime(temp, mtime)
        {
            eprintln!("warn: preserve mtime {}: {e:#}", temp.display());
        }
    }
    if opts.verify || opts.perfect_verify {
        if opts.perfect_verify {
            let (again, len) = hash_file_phase(
                &planned.src,
                opts.hash_algo,
                "rechecking_source",
                &planned.src,
                None,
                planned.size,
            )?;
            if again != hash || len != total {
                return Err(anyhow!(
                    "perfect-verify source changed: {}",
                    planned.src.display()
                ));
            }
        }
        verify_destinations(planned, &written, opts, &hash, total)?;
    }
    if opts.healthy_roots().is_empty() {
        return Err(DestinationError("no destinations remain after verification".into()).into());
    }
    let finalising = Phase::start("finalising", Some(&planned.src), None, 0);
    for (dest, temp) in pending {
        if opts.failed(&dest) {
            continue;
        }
        if let Err(e) = fs::rename(&temp, &dest) {
            opts.fail(&dest, format!("publish {}: {e}", dest.display()))?;
        }
    }
    ready.retain(|d| !opts.failed(d));
    if ready.is_empty() {
        return Err(DestinationError("no destinations published".into()).into());
    }

    if opts.mode == CopyMode::Move {
        // Keep recovery footage whenever any configured copy is missing.
        if opts.failures.borrow().is_empty() {
            fs::remove_file(&planned.src)
                .with_context(|| format!("move: delete source {}", planned.src.display()))?;
        } else {
            crate::events::emit(
                &serde_json::json!({"type":"warning","operation":"move_source_retained","message":"Source retained because a destination failed"}),
            );
        }
    }
    finalising.finish();
    Ok(FileOutcome::Copied {
        bytes: total,
        hash,
        destinations: ready
            .iter()
            .filter(|d| !opts.failed(d))
            .map(|d| root_for_path(d, opts.dests).to_path_buf())
            .collect(),
    })
}

fn root_for_path<'a>(dest: &'a Path, roots: &'a [PathBuf]) -> &'a Path {
    roots
        .iter()
        .filter(|root| dest.starts_with(root))
        .max_by_key(|root| root.components().count())
        .map_or(dest, |root| root.as_path())
}

fn writer_queue_chunks(per_mib: u64, total_mib: u64, writers: usize) -> Result<usize> {
    let per_chunks = per_mib.saturating_mul(1024 * 1024) / CHUNK_SIZE as u64;
    let total_chunks = total_mib.min(2048).saturating_mul(1024 * 1024) / CHUNK_SIZE as u64;
    // Reserve a chunk in every worker, the producer chunk and its read buffer.
    let available = total_chunks.saturating_sub(writers as u64 + 2);
    let chunks = per_chunks
        .saturating_sub(1)
        .min(available / writers.max(1) as u64);
    if chunks == 0 {
        return Err(anyhow!(
            "writer memory budget is too small for {writers} destinations"
        ));
    }
    Ok(chunks as usize)
}

// Generic helpers remain for deterministic failure tests. Production copies use
// the bounded per-destination worker queues below.
#[cfg(test)]
fn write_chunk<W: Write>(
    writers: &mut Vec<(W, PathBuf)>,
    data: &[u8],
    opts: &CopyOptions<'_>,
) -> Result<()> {
    let mut i = 0;
    while i < writers.len() {
        match writers[i].0.write_all(data) {
            Ok(()) => {
                crate::events::destination_write(
                    &writers[i].1,
                    data.len() as u64,
                    Duration::from_millis(1),
                );
                i += 1;
            }
            Err(e) => {
                opts.fail(
                    &writers[i].1,
                    format!("write {}: {e}", writers[i].1.display()),
                )?;
                writers.remove(i);
            }
        }
    }
    if writers.is_empty() {
        return Err(DestinationError("no writers remain".into()).into());
    }
    Ok(())
}
#[cfg(test)]
fn flush_writers<W: Write>(writers: &mut Vec<(W, PathBuf)>, opts: &CopyOptions<'_>) -> Result<()> {
    let mut i = 0;
    while i < writers.len() {
        match writers[i].0.flush() {
            Ok(()) => i += 1,
            Err(e) => {
                opts.fail(
                    &writers[i].1,
                    format!("flush {}: {e}", writers[i].1.display()),
                )?;
                writers.remove(i);
            }
        }
    }
    if writers.is_empty() {
        return Err(DestinationError("no flushed writers remain".into()).into());
    }
    Ok(())
}

fn disable_file_cache(file: &File) {
    #[cfg(target_os = "macos")]
    unsafe {
        use std::os::fd::AsRawFd;
        let _ = libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = file;
}

fn preallocate(file: &File, size: u64) -> Option<String> {
    #[cfg(target_os = "macos")]
    if size > 0 {
        use std::os::fd::AsRawFd;
        let mut store = libc::fstore_t {
            fst_flags: libc::F_ALLOCATECONTIG,
            fst_posmode: libc::F_PEOFPOSMODE,
            fst_offset: 0,
            fst_length: size.min(i64::MAX as u64) as libc::off_t,
            fst_bytesalloc: 0,
        };
        let fd = file.as_raw_fd();
        let mut result = unsafe { libc::fcntl(fd, libc::F_PREALLOCATE, &mut store) };
        if result == -1 {
            store.fst_flags = libc::F_ALLOCATEALL;
            result = unsafe { libc::fcntl(fd, libc::F_PREALLOCATE, &mut store) };
        }
        if result == -1 {
            return Some(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (file, size);
    None
}

fn create_copy_file(dest: &Path, size: u64, opts: &CopyOptions<'_>) -> Result<File> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(dest)
        .with_context(|| format!("create {}", dest.display()))?;
    let warning = preallocate(&file, size);
    #[cfg(all(feature = "test-hooks", debug_assertions))]
    let warning = if std::env::var_os("DITCOPY_TEST_PREALLOC_FAIL").is_some() {
        Some("injected unsupported preallocation".to_string())
    } else {
        warning
    };
    if let Some(message) = warning {
        let root = root_for_path(dest, opts.dests);
        if opts
            .runtime
            .borrow_mut()
            .preallocation_warned
            .insert(root.to_path_buf())
        {
            eprintln!(
                "warn: destination preallocation unsupported for {}: {message}",
                root.display()
            );
            crate::events::emit(
                &serde_json::json!({"type":"warning","operation":"preallocation","destination":root,"message":message}),
            );
        }
    }
    disable_file_cache(&file);
    Ok(file)
}

fn apply_writer_cooldown(
    states: &Mutex<BTreeMap<PathBuf, Cooldown>>,
    root: &Path,
    bytes: u64,
    elapsed: Duration,
    filled: bool,
    config: (u64, u64, u8),
) {
    if config.0 == 0 {
        return;
    }
    let pause = {
        let mut states = states.lock().unwrap();
        let state = states.entry(root.to_path_buf()).or_default();
        if filled || state.baseline.is_some() {
            state
                .observe(bytes, elapsed, config.1, config.2)
                .map(|(current, baseline)| (state.total_bytes, current, baseline))
        } else {
            None
        }
    };
    if let Some((bytes, current, baseline)) = pause {
        crate::events::emit(
            &serde_json::json!({"type":"cooldown_pause","destination":root,"seconds":config.0,"bytes":bytes,"speedBps":current,"baselineBps":baseline}),
        );
        thread::sleep(Duration::from_secs(config.0));
    }
}

fn copy_small_file(
    planned: &PlannedFile,
    active: &[PathBuf],
    opts: &CopyOptions<'_>,
) -> Result<(String, u64)> {
    let phase = Phase::start("copying", Some(&planned.src), None, planned.size);
    let started = Instant::now();
    let source = File::open(&planned.src)
        .with_context(|| format!("open source {}", planned.src.display()))?;
    disable_file_cache(&source);
    let mut data = Vec::with_capacity(planned.size as usize);
    source.take(CHUNK_SIZE as u64).read_to_end(&mut data)?;
    if data.len() as u64 != planned.size {
        return Err(anyhow!(
            "source size changed while copying {}",
            planned.src.display()
        ));
    }
    let mut hash = StreamingHasher::new(opts.hash_algo);
    hash.update(&data);
    for dest in active {
        match create_copy_file(dest, planned.size, opts) {
            Ok(file) => {
                let root = root_for_path(dest, opts.dests);
                #[cfg(all(feature = "test-hooks", debug_assertions))]
                let file = test_writer::Writer::from_env(file, root);
                let mut file = file;
                let written = Instant::now();
                if let Err(e) = file.write_all(&data).and_then(|_| file.flush()) {
                    opts.fail(
                        dest,
                        format!("write {}: {e}", published_path(dest).display()),
                    )?;
                    continue;
                }
                crate::events::destination_write(root, data.len() as u64, written.elapsed());
                apply_writer_cooldown(
                    &opts.runtime.borrow().cooldown,
                    root,
                    data.len() as u64,
                    written.elapsed(),
                    false,
                    (
                        opts.cooldown_seconds,
                        opts.cooldown_every_gb.saturating_mul(1024 * 1024 * 1024),
                        opts.cooldown_drop_percent,
                    ),
                );
            }
            Err(e) => opts.fail(dest, format!("create {}: {e:#}", dest.display()))?,
        }
    }
    if !active.iter().any(|d| !opts.failed(d)) {
        return Err(DestinationError("no small file destinations completed".into()).into());
    }
    phase.progress(data.len() as u64);
    throttle_sleep(opts.speed, started.elapsed());
    phase.finish();
    Ok((hash.finalize(), data.len() as u64))
}

struct QueuedWriter {
    dest: PathBuf,
    sender: Option<SyncSender<Arc<Vec<u8>>>>,
    queue_filled: Arc<AtomicBool>,
    worker: thread::JoinHandle<std::result::Result<(), String>>,
}

fn copy_chunk_fanout(
    planned: &PlannedFile,
    active: &[PathBuf],
    opts: &CopyOptions<'_>,
) -> Result<(String, u64)> {
    if planned.size < CHUNK_SIZE as u64 {
        return copy_small_file(planned, active, opts);
    }
    let queue_chunks = writer_queue_chunks(
        opts.writer_buffer_mib,
        opts.writer_total_buffer_mib,
        active.len(),
    )?;
    if !opts.runtime.borrow().queue_reported {
        crate::events::emit(
            &serde_json::json!({"type":"writer_buffer_budget","perDestinationMiB":opts.writer_buffer_mib,"totalMiB":opts.writer_total_buffer_mib.min(2048),"queueChunks":queue_chunks,"chunkBytes":CHUNK_SIZE,"destinations":active.len()}),
        );
        opts.runtime.borrow_mut().queue_reported = true;
    }
    let phase = Phase::start("copying", Some(&planned.src), None, planned.size);
    let mut source = File::open(&planned.src)
        .with_context(|| format!("open source {}", planned.src.display()))?;
    disable_file_cache(&source);
    let mut writers = Vec::new();
    let mut failures = Vec::new();
    for dest in active {
        match create_copy_file(dest, planned.size, opts) {
            Ok(file) => {
                let root = root_for_path(dest, opts.dests).to_path_buf();
                let writer_root = root.clone();
                let writer_path = published_path(dest);
                let (sender, receiver) = sync_channel::<Arc<Vec<u8>>>(queue_chunks);
                let queue_filled = Arc::new(AtomicBool::new(false));
                let writer_filled = Arc::clone(&queue_filled);
                let cooldown = Arc::clone(&opts.runtime.borrow().cooldown);
                let config = (
                    opts.cooldown_seconds,
                    opts.cooldown_every_gb.saturating_mul(1024 * 1024 * 1024),
                    opts.cooldown_drop_percent,
                );
                let worker = thread::spawn(move || {
                    #[cfg(all(feature = "test-hooks", debug_assertions))]
                    let file = test_writer::Writer::from_env(file, &writer_root);
                    let mut file = file;
                    for chunk in receiver {
                        let started = Instant::now();
                        file.write_all(&chunk)
                            .map_err(|e| format!("write {}: {e}", writer_path.display()))?;
                        crate::events::destination_write(
                            &writer_root,
                            chunk.len() as u64,
                            started.elapsed(),
                        );
                        apply_writer_cooldown(
                            &cooldown,
                            &writer_root,
                            chunk.len() as u64,
                            started.elapsed(),
                            writer_filled.load(Ordering::Acquire),
                            config,
                        );
                    }
                    file.flush()
                        .map_err(|e| format!("flush {}: {e}", writer_path.display()))
                });
                writers.push(QueuedWriter {
                    dest: dest.clone(),
                    sender: Some(sender),
                    queue_filled,
                    worker,
                });
            }
            Err(e) => failures.push((dest.clone(), format!("create {}: {e:#}", dest.display()))),
        }
    }
    if writers.is_empty() {
        for (dest, error) in failures {
            opts.fail(&dest, error)?;
        }
        return Err(DestinationError("no created writers remain".into()).into());
    }
    let mut hash = StreamingHasher::new(opts.hash_algo);
    let mut buf = vec![0; CHUNK_SIZE];
    let mut total = 0;
    let mut read_error = None;
    let mut strict_failure = !failures.is_empty() && !opts.nonstop;
    loop {
        if strict_failure {
            break;
        }
        let started = Instant::now();
        let n = match source.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                read_error = Some(e);
                break;
            }
        };
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        let chunk = Arc::new(buf[..n].to_vec());
        let mut live = 0;
        for writer in &mut writers {
            let Some(sender) = writer.sender.as_ref() else {
                continue;
            };
            let sent = match sender.try_send(Arc::clone(&chunk)) {
                Ok(()) => true,
                Err(TrySendError::Full(data)) => {
                    writer.queue_filled.store(true, Ordering::Release);
                    sender.send(data).is_ok()
                }
                Err(TrySendError::Disconnected(_)) => false,
            };
            if !sent {
                writer.sender = None;
                // The joined worker owns the real I/O error. A closed channel
                // is only a signal to stop enqueueing, never the user error.
                strict_failure |= !opts.nonstop;
            } else {
                live += 1;
            }
        }
        total += n as u64;
        phase.progress(total);
        throttle_sleep(opts.speed, started.elapsed());
        if live == 0 || strict_failure {
            break;
        }
    }
    for writer in &mut writers {
        writer.sender = None;
    }
    for writer in writers {
        match writer.worker.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push((writer.dest, error)),
            Err(_) => failures.push((writer.dest, "destination writer panicked".into())),
        }
    }
    crate::events::finish_speed_samples();
    for (dest, error) in failures {
        opts.fail(&dest, error)?;
    }
    if let Some(error) = read_error {
        return Err(error).with_context(|| format!("read source {}", planned.src.display()));
    }
    if opts.healthy_roots().is_empty() {
        return Err(DestinationError("no writers remain".into()).into());
    }
    phase.finish();
    Ok((hash.finalize(), total))
}
fn copy_same_disk(
    planned: &PlannedFile,
    active: &[PathBuf],
    opts: &CopyOptions<'_>,
) -> Result<(String, u64)> {
    let mut result: Option<(String, u64)> = None;
    for dest in active {
        if opts.failed(dest) {
            continue;
        }
        let copied = copy_chunk_fanout(planned, std::slice::from_ref(dest), opts)?;
        if opts.failed(dest) {
            continue;
        }
        if let Some((hash, bytes)) = &result {
            if copied.0 != *hash || copied.1 != *bytes {
                return Err(anyhow!(
                    "source changed between same disk destination passes: {}",
                    planned.src.display()
                ));
            }
        } else {
            result = Some(copied);
        }
    }
    result.ok_or_else(|| DestinationError("no same disk destinations completed".into()).into())
}
fn verify_destinations(
    planned: &PlannedFile,
    dests: &[PathBuf],
    opts: &CopyOptions<'_>,
    hash: &str,
    total: u64,
) -> Result<()> {
    for dest in dests {
        if opts.failed(dest) {
            continue;
        }
        let phase = hash_file_phase(
            dest,
            opts.hash_algo,
            "verifying_destination",
            &planned.src,
            Some(dest),
            total,
        );
        match phase {
            Ok((got, len)) if got == hash && len == total => {
                crate::events::destination_verified(root_for_path(dest, opts.dests), total)
            }
            Ok((_got, len)) => {
                if opts.mode != CopyMode::VerifyOnly {
                    rename_verify_err(dest);
                }
                opts.fail(
                    dest,
                    format!(
                        "verify mismatch {}: dest_bytes={len} src_bytes={total}",
                        dest.display()
                    ),
                )?;
            }
            Err(e) => opts.fail(dest, format!("verify read {}: {e:#}", dest.display()))?,
        }
    }
    if opts.healthy_roots().is_empty() {
        return Err(DestinationError("no destinations remain after verification".into()).into());
    }
    Ok(())
}
pub fn verify_only_file(
    planned: &PlannedFile,
    dests: &[PathBuf],
    opts: &CopyOptions<'_>,
) -> Result<FileOutcome> {
    let (hash, bytes) = hash_file_phase(
        &planned.src,
        opts.hash_algo,
        "rechecking_source",
        &planned.src,
        None,
        planned.size,
    )?;
    for dest in dests {
        crate::events::destination_begin(root_for_path(dest, opts.dests));
    }
    verify_destinations(planned, dests, opts, &hash, bytes)?;
    Ok(FileOutcome::Verified {
        bytes,
        hash,
        destinations: dests
            .iter()
            .filter(|d| !opts.failed(d))
            .map(|d| root_for_path(d, opts.dests).to_path_buf())
            .collect(),
    })
}

#[cfg(test)]
mod tests;

/// After sync copy: delete dest files/dirs not present in the planned source tree.
/// Returns list of deleted relative paths (forward slashes) under each dest.
pub fn sync_delete_extras(
    dest_roots: &[PathBuf],
    planned: &[PlannedFile],
) -> Result<Vec<(PathBuf, String, u64)>> {
    let planned_files: HashSet<String> = planned.iter().map(|p| rel_forward(&p.rel)).collect();
    let mut planned_dirs: HashSet<String> = HashSet::new();
    for p in planned {
        let rel = rel_forward(&p.rel);
        let mut acc = String::new();
        for part in Path::new(&rel).components() {
            let s = part.as_os_str().to_string_lossy();
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(&s);
            if acc != rel {
                planned_dirs.insert(acc.clone());
            }
        }
    }

    let mut deleted: Vec<(PathBuf, String, u64)> = Vec::new();

    for dest_root in dest_roots {
        if !dest_root.exists() {
            continue;
        }
        let mut file_paths: Vec<PathBuf> = Vec::new();
        let mut dir_paths: Vec<PathBuf> = Vec::new();

        for entry in WalkDir::new(dest_root).follow_links(false) {
            let entry = entry.with_context(|| format!("walk dest {}", dest_root.display()))?;
            let path = entry.path().to_path_buf();
            if path == *dest_root {
                continue;
            }
            if entry.file_type().is_file() {
                file_paths.push(path);
            } else if entry.file_type().is_dir() {
                dir_paths.push(path);
            }
        }

        for path in &file_paths {
            let rel = path.strip_prefix(dest_root).unwrap_or(path).to_path_buf();
            let rel_s = rel_forward(&rel);
            if planned_files.contains(&rel_s) {
                continue;
            }
            let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            fs::remove_file(path)
                .with_context(|| format!("sync delete file {}", path.display()))?;
            deleted.push((path.clone(), rel_s, bytes));
        }

        // Remove dirs deepest-first if not part of planned tree
        dir_paths.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for path in &dir_paths {
            let rel = path.strip_prefix(dest_root).unwrap_or(path).to_path_buf();
            let rel_s = rel_forward(&rel);
            if planned_dirs.contains(&rel_s)
                || planned_files
                    .iter()
                    .any(|f| f.starts_with(&format!("{rel_s}/")))
            {
                continue;
            }
            // Only remove if empty (or became empty after file deletes)
            match fs::remove_dir(path) {
                Ok(()) => {
                    deleted.push((path.clone(), rel_s, 0));
                }
                Err(_) => {
                    // Non-empty or busy — leave it
                }
            }
        }
    }

    Ok(deleted)
}
