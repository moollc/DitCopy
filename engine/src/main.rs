mod checkpoint;
mod copy;
mod events;
mod filters;
mod hash;
mod probe;

use anyhow::Result;
use checkpoint::Checkpoint;
use clap::{Parser, Subcommand};
use copy::{
    CopyMode, CopyOptions, DiskMode, FileOutcome, PlannedFile, SpeedMode, collect_files,
    copy_one_file, dest_path, should_skip, sync_delete_extras,
};
use events::{Phase, emit, emit_progress};
use filters::{Filters, rel_forward};
use hash::{HashAlgo, hash_file, hash_file_phase_at};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;
use std::time::UNIX_EPOCH;

#[derive(Parser, Debug)]
#[command(name = "ditcopy_engine", version, about = "DitCopy copy/hash engine")]
struct Cli {
    #[command(subcommand)]
    cmd: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Recursive copy from sources to destinations (multi-dest fan-out)
    Copy(Box<CopyArgs>),
    /// Compare src vs dest by size + hash (no copy)
    Verify(VerifyArgs),
    /// Print hash for a file (hex)
    Hash(HashArgs),
    /// Write and reread a temporary 64 MiB file with the filesystem cache bypassed
    ProbeDrive(ProbeArgs),
}

#[derive(Parser, Debug)]
struct ProbeArgs {
    #[arg(long)]
    dest: PathBuf,
    #[arg(long)]
    probe_id: String,
}

#[derive(Parser, Debug)]
struct CopyArgs {
    #[arg(long = "src", required = true)]
    src: Vec<PathBuf>,

    /// Destination roots (optional/ignored for delete mode)
    #[arg(long = "dest")]
    dest: Vec<PathBuf>,

    #[arg(long, value_enum, default_value_t = CopyMode::Force)]
    mode: CopyMode,

    /// After write, re-read dest and compare hash (default true; pass --verify=false to disable)
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    verify: bool,

    /// Re-hash source and each dest after write; both must match streaming hash
    #[arg(long, default_value_t = false)]
    perfect_verify: bool,

    #[arg(long, value_enum, default_value_t = HashAlgo::Xxh3)]
    hash: HashAlgo,

    /// Semicolon-separated include globs (relative path, forward slashes)
    #[arg(long)]
    include: Option<String>,

    /// Semicolon-separated exclude globs
    #[arg(long)]
    exclude: Option<String>,

    #[arg(long)]
    min_size: Option<u64>,

    #[arg(long)]
    max_size: Option<u64>,

    /// Include files with mtime on/after YYYYMMDD
    #[arg(long)]
    from_date: Option<String>,

    /// Include files with mtime on/before YYYYMMDD
    #[arg(long)]
    to_date: Option<String>,

    #[arg(long, value_enum, default_value_t = SpeedMode::Full)]
    speed: SpeedMode,

    #[arg(long, value_enum, default_value_t = DiskMode::Auto)]
    disk_mode: DiskMode,

    /// Memory per destination, including its in flight write chunk
    #[arg(long, default_value_t = 1024, value_parser = clap::value_parser!(u64).range(16..=2048))]
    writer_buffer_mib: u64,
    /// Total copy buffer cap per engine job, including workers and reader
    #[arg(long, default_value_t = 2048, value_parser = clap::value_parser!(u64).range(32..=2048))]
    writer_total_buffer_mib: u64,
    #[arg(long, default_value_t = 0)]
    cooldown_seconds: u64,
    #[arg(long, default_value_t = 0)]
    cooldown_every_gb: u64,
    #[arg(long, default_value_t = 20)]
    cooldown_drop_percent: u8,

    /// Continue on file errors
    #[arg(long, default_value_t = false)]
    nonstop: bool,

    /// Required for sync|move|delete
    #[arg(long, default_value_t = false)]
    confirm: bool,

    #[arg(long)]
    job_id: Option<String>,

    /// Write/update checkpoint JSON after each successful file
    #[arg(long)]
    checkpoint: Option<PathBuf>,

    /// Read resume entries from an earlier job checkpoint
    #[arg(long)]
    resume_checkpoint: Option<PathBuf>,

    /// Atomic pause/stop request file, checked only at file boundaries
    #[arg(long)]
    control_file: Option<PathBuf>,
}

#[derive(Parser, Debug)]
struct VerifyArgs {
    #[arg(long = "src", required = true)]
    src: Vec<PathBuf>,

    #[arg(long = "dest", required = true)]
    dest: Vec<PathBuf>,

    #[arg(long, value_enum, default_value_t = HashAlgo::Xxh3)]
    hash: HashAlgo,

    #[arg(long, default_value_t = false)]
    nonstop: bool,

    #[arg(long)]
    job_id: Option<String>,
}

#[derive(Parser, Debug)]
struct HashArgs {
    path: PathBuf,

    #[arg(long, value_enum, default_value_t = HashAlgo::Xxh3)]
    hash: HashAlgo,
}

#[derive(Serialize)]
struct EventStart {
    #[serde(rename = "type")]
    type_: &'static str,
    job_id: String,
    files: u64,
    bytes: u64,
    work_bytes: u64,
    work_copy_bytes: u64,
    work_read_bytes: u64,
    work_recheck_bytes: u64,
    work_verify_bytes: u64,
    work_files: u64,
    mode: String,
    hash_algo: String,
}

#[derive(Serialize)]
struct EventProgress {
    #[serde(rename = "type")]
    type_: &'static str,
    copied_files: u64,
    copied_bytes: u64,
    current: String,
    speed_bps: u64,
}

#[derive(Serialize)]
struct EventFile {
    #[serde(rename = "type")]
    type_: &'static str,
    path: String,
    bytes: u64,
    hash: String,
    status: String,
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destinations: Option<Vec<PathBuf>>,
}

#[derive(Serialize)]
struct EventDone {
    #[serde(rename = "type")]
    type_: &'static str,
    ok: bool,
    copied_files: u64,
    skipped: u64,
    errors: u64,
    bytes: u64,
    elapsed_ms: u64,
    source_errors: u64,
    failed_destinations: BTreeMap<PathBuf, String>,
    completed_destinations: Vec<PathBuf>,
}

#[derive(Serialize)]
struct EventError {
    #[serde(rename = "type")]
    type_: &'static str,
    message: String,
}

fn emit_error(message: impl Into<String>) {
    emit(&EventError {
        type_: "error",
        message: message.into(),
    });
}

struct JobStats {
    copied_files: u64,
    skipped: u64,
    errors: u64,
    bytes: u64,
}

fn process_copy(args: CopyArgs) -> ExitCode {
    events::configure_destinations(&args.dest);
    if args.mode.requires_confirm() && !args.confirm {
        emit_error(format!(
            "mode {} requires --confirm; refusing to run (no filesystem changes)",
            args.mode.as_str()
        ));
        return ExitCode::from(2);
    }

    for path in args.checkpoint.iter().chain(args.resume_checkpoint.iter()) {
        if let Err(e) = Checkpoint::clean_stale_temps(path) {
            emit_error(format!("checkpoint temp cleanup: {e:#}"));
            return ExitCode::from(1);
        }
    }

    if args.mode != CopyMode::Delete && args.dest.is_empty() {
        emit_error("at least one --dest is required (except delete mode)");
        return ExitCode::from(1);
    }

    let filters = match Filters::new(
        args.include.as_deref(),
        args.exclude.as_deref(),
        args.min_size,
        args.max_size,
        args.from_date.as_deref(),
        args.to_date.as_deref(),
    ) {
        Ok(f) => f,
        Err(e) => {
            emit_error(format!("{e:#}"));
            return ExitCode::from(1);
        }
    };

    let started = Instant::now();

    let files = match collect_files(&args.src) {
        Ok(f) => f,
        Err(e) => {
            emit_error(format!("{e:#}"));
            return ExitCode::from(1);
        }
    };

    let mut resume = Checkpoint::default();
    if let Some(path) = &args.resume_checkpoint {
        match Checkpoint::load(path) {
            Ok(cp) => resume = cp,
            Err(e) => {
                emit_error(format!("{e:#}"));
                return ExitCode::from(1);
            }
        }
    }

    let mut checkpoint = if let Some(path) = &args.checkpoint {
        match Checkpoint::load(path) {
            Ok(cp) => cp,
            Err(e) => {
                emit_error(format!("{e:#}"));
                return ExitCode::from(1);
            }
        }
    } else {
        Checkpoint::default()
    };

    if let Some(path) = &args.checkpoint
        && !path.exists()
        && let Err(e) = checkpoint.save(path)
    {
        emit_error(format!("checkpoint initialize: {e:#}"));
        return ExitCode::from(1);
    }

    let total_bytes: u64 = files.iter().map(|f| f.size).sum();
    let mut work_copy_bytes = 0u64;
    // Streaming reads are included in each copying pass, not a separate phase.
    let work_read_bytes = 0u64;
    let mut work_recheck_bytes = 0u64;
    let mut work_verify_bytes = 0u64;
    let mut work_files = 0u64;
    for planned in &files {
        let current = rel_forward(&planned.rel);
        let src_mtime = std::fs::metadata(&planned.src)
            .ok()
            .and_then(|m| m.modified().ok());
        if filters.check(&current, planned.size, src_mtime).is_err() {
            continue;
        }
        let src_mtime_secs = src_mtime
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let active_destinations = if args.mode == CopyMode::VerifyOnly {
            args.dest.len()
        } else {
            args.dest
                .iter()
                .filter(|root| {
                    !should_skip(
                        args.mode,
                        &dest_path(root, &planned.rel),
                        planned.size,
                        src_mtime_secs,
                    )
                })
                .count()
        };
        if active_destinations == 0 || args.mode == CopyMode::Delete {
            continue;
        }
        if args.mode == CopyMode::VerifyOnly {
            work_recheck_bytes = work_recheck_bytes.saturating_add(planned.size);
            work_verify_bytes = work_verify_bytes
                .saturating_add(planned.size.saturating_mul(active_destinations as u64));
        } else {
            if args.disk_mode == DiskMode::Same {
                work_copy_bytes = work_copy_bytes
                    .saturating_add(planned.size.saturating_mul(active_destinations as u64));
            } else {
                work_copy_bytes = work_copy_bytes.saturating_add(planned.size);
            }
            if args.perfect_verify {
                work_recheck_bytes = work_recheck_bytes.saturating_add(planned.size);
            }
            if args.verify || args.perfect_verify {
                work_verify_bytes = work_verify_bytes
                    .saturating_add(planned.size.saturating_mul(active_destinations as u64));
            }
        }
        work_files += 1;
    }
    let work_bytes = work_copy_bytes
        .saturating_add(work_read_bytes)
        .saturating_add(work_recheck_bytes)
        .saturating_add(work_verify_bytes);
    emit(&EventStart {
        type_: "start",
        job_id: args.job_id.clone().expect("job identifier initialised"),
        files: files.len() as u64,
        bytes: total_bytes,
        work_bytes,
        work_copy_bytes,
        work_read_bytes,
        work_recheck_bytes,
        work_verify_bytes,
        work_files,
        mode: args.mode.as_str().to_string(),
        hash_algo: args.hash.as_str().to_string(),
    });

    let mut stats = JobStats {
        copied_files: 0,
        skipped: 0,
        errors: 0,
        bytes: 0,
    };

    let failures = RefCell::new(BTreeMap::new());
    let mut aborted = false;
    let opts = CopyOptions {
        runtime: std::rc::Rc::new(RefCell::new(copy::CopyRuntime::default())),
        writer_buffer_mib: args.writer_buffer_mib,
        writer_total_buffer_mib: args.writer_total_buffer_mib,
        nonstop: args.nonstop,
        failures: &failures,
        mode: args.mode,
        dests: &args.dest,
        verify: args.verify,
        perfect_verify: args.perfect_verify,
        hash_algo: args.hash,
        speed: args.speed,
        disk_mode: args.disk_mode,
        cooldown_seconds: args.cooldown_seconds,
        cooldown_every_gb: args.cooldown_every_gb,
        cooldown_drop_percent: args.cooldown_drop_percent,
    };

    // Rel paths that pass filters (used as sync source-of-truth)
    let mut sync_planned: Vec<&PlannedFile> = Vec::new();

    let mut boundary_state: Option<&str> = None;
    for planned in &files {
        if let Some(request) = read_control(args.control_file.as_deref()) {
            let state = if request == "pause" {
                "paused"
            } else {
                "stopped"
            };
            emit(&serde_json::json!({"type":"job_state","state":state}));
            boundary_state = Some(state);
            break;
        }
        events::set_file_size(planned.size);
        let current = rel_forward(&planned.rel);
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        let speed = (stats.bytes as f64 / elapsed) as u64;
        emit_progress(&EventProgress {
            type_: "progress",
            copied_files: stats.copied_files,
            copied_bytes: stats.bytes,
            current: current.clone(),
            speed_bps: speed,
        });

        // Filters
        let src_mtime = std::fs::metadata(&planned.src)
            .ok()
            .and_then(|m| m.modified().ok());
        if let Err(reason) = filters.check(&current, planned.size, src_mtime) {
            stats.skipped += 1;
            emit(&EventFile {
                type_: "file",
                path: current,
                bytes: planned.size,
                hash: String::new(),
                status: "skipped".into(),
                error: Some(reason),
                destinations: None,
            });
            continue;
        }
        sync_planned.push(planned);

        let destination_files: Vec<String> = args
            .dest
            .iter()
            .map(|root| dest_path(root, &planned.rel).to_string_lossy().into_owned())
            .collect();
        if let Some(entry) = args
            .resume_checkpoint
            .as_ref()
            .and_then(|_| resume.entry(&current))
        {
            let total = planned
                .size
                .saturating_mul(destination_files.len() as u64 + 1);
            let phase = Phase::start("resume_validation", Some(&planned.src), None, total);
            let valid = resume_entry_valid(entry, planned, &destination_files, args.hash, &phase);
            phase.finish();
            if valid {
                let hash = entry.hash.clone();
                stats.skipped += 1;
                checkpoint.mark_done(
                    &current,
                    planned.size,
                    &hash,
                    source_mtime_ns(&planned.src),
                    &destination_files,
                );
                if let Some(path) = &args.checkpoint
                    && let Err(e) = checkpoint.save(path)
                {
                    stats.errors += 1;
                    emit_error(format!("checkpoint save: {e:#}"));
                }
                emit(&EventFile {
                    type_: "file",
                    path: current,
                    bytes: planned.size,
                    hash,
                    status: "verified".into(),
                    error: Some("resume validation passed".into()),
                    destinations: None,
                });
                continue;
            }
        }

        match handle_one(planned, &opts) {
            Ok(FileOutcome::Copied {
                bytes,
                hash,
                destinations,
            }) => {
                stats.copied_files += 1;
                stats.bytes += bytes;
                emit(&EventFile {
                    type_: "file",
                    path: current.clone(),
                    bytes,
                    hash: hash.clone(),
                    status: "copied".into(),
                    error: None,
                    destinations: Some(destinations.clone()),
                });
                if args.checkpoint.is_some() && failures.borrow().is_empty() {
                    let phase = Phase::start("finalising", Some(&planned.src), None, 0);
                    let source_mtime = source_mtime_ns(&planned.src);
                    checkpoint.mark_done(&current, bytes, &hash, source_mtime, &destination_files);
                    if let Some(path) = &args.checkpoint {
                        if let Err(e) = checkpoint.save(path) {
                            stats.errors += 1;
                            eprintln!("checkpoint save failed: {e:#}");
                            emit(&serde_json::json!({
                                "type": "warning", "message": format!("checkpoint save: {e:#}"),
                                "operation": "checkpoint_save", "path": path,
                            }));
                        } else {
                            phase.finish();
                        }
                    }
                }
            }
            Ok(FileOutcome::Skipped { bytes, hash }) => {
                stats.skipped += 1;
                emit(&EventFile {
                    type_: "file",
                    path: current,
                    bytes,
                    hash,
                    status: "skipped".into(),
                    error: None,
                    destinations: None,
                });
            }
            Ok(FileOutcome::Verified {
                bytes,
                hash,
                destinations,
            }) => {
                stats.copied_files += 1;
                stats.bytes += bytes;
                emit(&EventFile {
                    type_: "file",
                    path: current,
                    bytes,
                    hash,
                    status: "copied".into(),
                    error: None,
                    destinations: Some(destinations.clone()),
                });
            }
            Ok(FileOutcome::Deleted { bytes }) => {
                stats.copied_files += 1;
                emit(&EventFile {
                    type_: "file",
                    path: current,
                    bytes,
                    hash: String::new(),
                    status: "deleted".into(),
                    error: None,
                    destinations: None,
                });
            }
            Err(e) => {
                if e.downcast_ref::<copy::DestinationError>().is_none() {
                    stats.errors += 1;
                }
                emit(&EventFile {
                    type_: "file",
                    path: current,
                    bytes: planned.size,
                    hash: String::new(),
                    status: "error".into(),
                    error: Some(format!("{e:#}")),
                    destinations: None,
                });
                if !args.nonstop || opts.healthy_roots().is_empty() {
                    aborted = true;
                    break;
                }
            }
        }
    }

    if boundary_state.is_none()
        && let Some(request) = read_control(args.control_file.as_deref())
    {
        let state = if request == "pause" {
            "paused"
        } else {
            "stopped"
        };
        emit(&serde_json::json!({"type":"job_state","state":state}));
        boundary_state = Some(state);
    }
    let files_finished = stats.copied_files + stats.skipped >= files.len() as u64;
    if let Some(state) = boundary_state
        && !files_finished
    {
        eprintln!("ditcopy: stopped at file boundary ({})", state);
        return ExitCode::SUCCESS;
    }

    let finalising = Phase::start("finalising", None, None, 0);
    let errors_before_finalising = stats.errors;
    // Sync: delete dest extras not in filtered source tree
    if args.mode == CopyMode::Sync && stats.errors == 0 {
        let owned: Vec<PlannedFile> = sync_planned
            .iter()
            .map(|p| PlannedFile {
                src: p.src.clone(),
                rel: p.rel.clone(),
                size: p.size,
            })
            .collect();
        match sync_delete_extras(&opts.healthy_roots(), &owned) {
            Ok(deleted) => {
                for (_abs, rel, bytes) in deleted {
                    stats.copied_files += 1;
                    emit(&EventFile {
                        type_: "file",
                        path: rel,
                        bytes,
                        hash: String::new(),
                        status: "deleted".into(),
                        error: None,
                        destinations: None,
                    });
                }
            }
            Err(e) => {
                stats.errors += 1;
                emit_error(format!("sync delete: {e:#}"));
            }
        }
    }

    if stats.errors == errors_before_finalising {
        finalising.finish();
    } else {
        drop(finalising);
    }
    let source_errors = stats.errors;
    let completed_destinations = if source_errors == 0 && !aborted {
        opts.healthy_roots()
    } else {
        Vec::new()
    };
    stats.errors += failures.borrow().len() as u64;
    let ok = stats.errors == 0;
    emit(&EventDone {
        type_: "done",
        ok,
        copied_files: stats.copied_files,
        skipped: stats.skipped,
        errors: stats.errors,
        bytes: stats.bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
        source_errors,
        failed_destinations: failures.borrow().clone(),
        completed_destinations,
    });

    eprintln!(
        "ditcopy: done ok={ok} copied={} skipped={} errors={} bytes={} ({:.1}s)",
        stats.copied_files,
        stats.skipped,
        stats.errors,
        stats.bytes,
        started.elapsed().as_secs_f64()
    );

    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn source_mtime_ns(path: &std::path::Path) -> Option<u128> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_nanos())
}

fn resume_entry_valid(
    entry: &checkpoint::CompletedEntry,
    planned: &PlannedFile,
    destinations: &[String],
    algo: HashAlgo,
    phase: &Phase,
) -> bool {
    let normalized_recorded: Option<Vec<PathBuf>> = entry
        .destinations
        .iter()
        .map(|p| fs::canonicalize(p).ok())
        .collect();
    let normalized_current: Option<Vec<PathBuf>> = destinations
        .iter()
        .map(|p| fs::canonicalize(p).ok())
        .collect();
    if entry.bytes != planned.size
        || entry.source_mtime_ns != source_mtime_ns(&planned.src)
        || entry.source_mtime_ns.is_none()
        || entry.destinations.is_empty()
        || entry.hash.is_empty()
        || normalized_recorded.is_none()
        || normalized_recorded != normalized_current
    {
        return false;
    }
    let Ok((source_hash, source_bytes)) = hash_file_phase_at(&planned.src, algo, phase, 0) else {
        return false;
    };
    if source_bytes != planned.size || source_hash != entry.hash {
        return false;
    }
    let mut progress_offset = planned.size;
    for destination in destinations {
        let path = std::path::Path::new(destination);
        let Ok(metadata) = fs::metadata(path) else {
            return false;
        };
        if !metadata.is_file() || metadata.len() != planned.size {
            return false;
        }
        let Ok((destination_hash, bytes)) = hash_file_phase_at(path, algo, phase, progress_offset)
        else {
            return false;
        };
        progress_offset = progress_offset.saturating_add(planned.size);
        if bytes != planned.size || destination_hash != entry.hash {
            return false;
        }
    }
    true
}

fn read_control(path: Option<&std::path::Path>) -> Option<String> {
    let path = path?;
    let request = fs::read_to_string(path).ok()?;
    match request.trim() {
        "pause" => Some("pause".into()),
        "stop" => Some("stop".into()),
        _ => None,
    }
}

fn handle_one(planned: &PlannedFile, opts: &CopyOptions<'_>) -> Result<FileOutcome> {
    copy_one_file(planned, opts)
}

fn process_verify(args: VerifyArgs) -> ExitCode {
    process_copy(CopyArgs {
        src: args.src,
        dest: args.dest,
        mode: CopyMode::VerifyOnly,
        verify: true,
        perfect_verify: false,
        hash: args.hash,
        include: None,
        exclude: None,
        min_size: None,
        max_size: None,
        from_date: None,
        to_date: None,
        speed: SpeedMode::Full,
        disk_mode: DiskMode::Auto,
        writer_buffer_mib: 1024,
        writer_total_buffer_mib: 2048,
        cooldown_seconds: 0,
        cooldown_every_gb: 0,
        cooldown_drop_percent: 20,
        nonstop: args.nonstop,
        confirm: false,
        job_id: args.job_id,
        checkpoint: None,
        resume_checkpoint: None,
        control_file: None,
    })
}

fn process_hash(args: HashArgs) -> ExitCode {
    match hash_file(&args.path, args.hash) {
        Ok((digest, _bytes)) => {
            println!("{digest}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(1)
        }
    }
}

fn main() -> ExitCode {
    let mut cli = Cli::parse();
    match &mut cli.cmd {
        Commands::Copy(args) => {
            let id = args
                .job_id
                .get_or_insert_with(|| chrono::Utc::now().format("%Y%m%dT%H%M%S%.f").to_string())
                .clone();
            events::init(id);
        }
        Commands::Verify(args) => {
            let id = args
                .job_id
                .get_or_insert_with(|| chrono::Utc::now().format("%Y%m%dT%H%M%S%.f").to_string())
                .clone();
            events::init(id);
        }
        Commands::Hash(_) | Commands::ProbeDrive(_) => {}
    }
    match cli.cmd {
        Commands::Copy(args) => process_copy(*args),
        Commands::Verify(args) => process_verify(args),
        Commands::Hash(args) => process_hash(args),
        Commands::ProbeDrive(args) => match probe::run(&args.dest, &args.probe_id) {
            Ok(value) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("error: {e:#}");
                ExitCode::from(1)
            }
        },
    }
}

#[cfg(test)]
mod resume_tests {
    use super::*;
    use checkpoint::CompletedEntry;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn resume_requires_all_destinations_to_match_source_hash() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ditcopy-resume-validation-{stamp}"));
        let src_dir = root.join("source");
        let dst_a = root.join("dest-a").join("source");
        let dst_b = root.join("dest-b").join("source");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_a).unwrap();
        fs::create_dir_all(&dst_b).unwrap();
        let source = src_dir.join("clip.bin");
        let dest_a = dst_a.join("clip.bin");
        let dest_b = dst_b.join("clip.bin");
        fs::write(&source, b"camera payload").unwrap();
        fs::write(&dest_a, b"camera payload").unwrap();
        fs::write(&dest_b, b"camera payload").unwrap();
        let (hash, bytes) = hash_file(&source, HashAlgo::Sha256).unwrap();
        let dests = vec![
            dest_a.to_string_lossy().into_owned(),
            dest_b.to_string_lossy().into_owned(),
        ];
        let planned = PlannedFile {
            src: source.clone(),
            rel: PathBuf::from("source/clip.bin"),
            size: bytes,
        };
        let entry = CompletedEntry {
            bytes,
            hash,
            source_mtime_ns: source_mtime_ns(&source),
            destinations: dests.clone(),
        };
        let phase = Phase::start("resume_validation", Some(&source), None, bytes * 3);
        assert!(resume_entry_valid(
            &entry,
            &planned,
            &dests,
            HashAlgo::Sha256,
            &phase
        ));
        phase.finish();
        #[cfg(unix)]
        {
            let alias = root.join("dest-a-alias");
            std::os::unix::fs::symlink(&dst_a, &alias).unwrap();
            let resolved_alias = alias.join("clip.bin").to_string_lossy().into_owned();
            let phase = Phase::start("resume_validation", Some(&source), None, bytes * 3);
            assert!(resume_entry_valid(
                &entry,
                &planned,
                &[resolved_alias, dests[1].clone()],
                HashAlgo::Sha256,
                &phase,
            ));
            phase.finish();
        }
        fs::write(&dest_b, b"x").unwrap();
        let phase = Phase::start("resume_validation", Some(&source), None, bytes * 3);
        assert!(!resume_entry_valid(
            &entry,
            &planned,
            &dests,
            HashAlgo::Sha256,
            &phase
        ));
        phase.finish();
    }
}
