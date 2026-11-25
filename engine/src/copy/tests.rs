use super::*;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn fixture() -> (PathBuf, PlannedFile, Vec<PathBuf>) {
    let dir = std::env::temp_dir()
        .join("ditcopy-test-b5-fix3")
        .join(format!(
            "unit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir_all(&dir).unwrap();
    let src = dir.join("source.bin");
    fs::write(&src, b"camera data").unwrap();
    (
        dir.clone(),
        PlannedFile {
            src,
            rel: PathBuf::from("card/one.bin"),
            size: 11,
        },
        vec![dir.join("bad"), dir.join("good")],
    )
}
fn options<'a>(
    roots: &'a [PathBuf],
    failures: &'a RefCell<BTreeMap<PathBuf, String>>,
    same: bool,
    nonstop: bool,
) -> CopyOptions<'a> {
    CopyOptions {
        runtime: Rc::new(RefCell::new(CopyRuntime::default())),
        writer_buffer_mib: 1024,
        writer_total_buffer_mib: 2048,
        dests: roots,
        failures,
        nonstop,
        mode: CopyMode::Force,
        verify: true,
        perfect_verify: true,
        hash_algo: HashAlgo::Xxh3,
        speed: SpeedMode::Full,
        disk_mode: if same { DiskMode::Same } else { DiskMode::Auto },
        cooldown_seconds: 0,
        cooldown_every_gb: 0,
        cooldown_drop_percent: 20,
    }
}
#[test]
fn mkdir_and_create_failures_drop_only_the_bad_root_for_remaining_files() {
    for same in [false, true] {
        for mkdir in [false, true] {
            let (_dir, one, roots) = fixture();
            if mkdir {
                fs::create_dir_all(&roots[0]).unwrap();
                fs::write(roots[0].join("card"), b"block directory").unwrap();
            } else {
                fs::create_dir_all(roots[0].join("card/one.bin")).unwrap();
            }
            let failures = RefCell::new(BTreeMap::new());
            let opts = options(&roots, &failures, same, true);
            assert!(matches!(
                copy_one_file(&one, &opts).unwrap(),
                FileOutcome::Copied { .. }
            ));
            assert_eq!(fs::read(roots[1].join(&one.rel)).unwrap(), b"camera data");
            assert_eq!(failures.borrow().len(), 1);
            let two = PlannedFile {
                src: one.src.clone(),
                rel: PathBuf::from("later/two.bin"),
                size: one.size,
            };
            copy_one_file(&two, &opts).unwrap();
            assert!(roots[1].join(&two.rel).exists());
            assert!(!roots[0].join(&two.rel).exists());
        }
    }
}
#[test]
fn strict_mode_stops_before_good_destination_but_records_which_failed() {
    let (_dir, one, roots) = fixture();
    fs::create_dir_all(&roots[0]).unwrap();
    fs::write(roots[0].join("card"), b"block").unwrap();
    let f = RefCell::new(BTreeMap::new());
    assert!(copy_one_file(&one, &options(&roots, &f, false, false)).is_err());
    assert!(f.borrow().contains_key(&roots[0]));
    assert!(!roots[1].join(&one.rel).exists());
}
#[test]
fn verify_mismatch_drops_bad_root_and_checks_good_root_in_both_modes() {
    for nonstop in [true, false] {
        let (_dir, one, roots) = fixture();
        for root in &roots {
            fs::create_dir_all(root.join("card")).unwrap();
        }
        fs::write(roots[0].join(&one.rel), b"damaged").unwrap();
        fs::write(roots[1].join(&one.rel), b"camera data").unwrap();
        let f = RefCell::new(BTreeMap::new());
        let mut opts = options(&roots, &f, false, nonstop);
        opts.mode = CopyMode::VerifyOnly;
        let result = copy_one_file(&one, &opts);
        assert_eq!(result.is_ok(), nonstop);
        assert!(f.borrow().contains_key(&roots[0]));
        if let Ok(FileOutcome::Verified { destinations, .. }) = result {
            assert_eq!(destinations, vec![roots[1].clone()]);
        }
    }
}
#[test]
fn missing_verification_destination_does_not_block_healthy_one() {
    let (_dir, one, roots) = fixture();
    fs::create_dir_all(roots[1].join("card")).unwrap();
    fs::write(roots[1].join(&one.rel), b"camera data").unwrap();
    let f = RefCell::new(BTreeMap::new());
    let mut opts = options(&roots, &f, false, true);
    opts.mode = CopyMode::VerifyOnly;
    assert!(copy_one_file(&one, &opts).is_ok());
    assert!(f.borrow().contains_key(&roots[0]));
}
struct FaultWriter {
    bytes: Rc<RefCell<Vec<u8>>>,
    limit: usize,
    flush_fails: bool,
}
impl Write for FaultWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let mut bytes = self.bytes.borrow_mut();
        if bytes.len() >= self.limit {
            return Err(std::io::Error::other("injected disk write failure"));
        }
        let n = data.len().min(self.limit - bytes.len());
        bytes.extend_from_slice(&data[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if self.flush_fails {
            Err(std::io::Error::other("injected flush failure"))
        } else {
            Ok(())
        }
    }
}
#[test]
fn partial_write_and_flush_failures_keep_the_other_writer_running() {
    for flush in [false, true] {
        let (_dir, _one, roots) = fixture();
        let f = RefCell::new(BTreeMap::new());
        let opts = options(&roots, &f, false, true);
        let good = Rc::new(RefCell::new(Vec::new()));
        let bad = Rc::new(RefCell::new(Vec::new()));
        let mut writers = vec![
            (
                FaultWriter {
                    bytes: bad,
                    limit: if flush { usize::MAX } else { 6 },
                    flush_fails: flush,
                },
                roots[0].clone(),
            ),
            (
                FaultWriter {
                    bytes: good.clone(),
                    limit: usize::MAX,
                    flush_fails: false,
                },
                roots[1].clone(),
            ),
        ];
        write_chunk(&mut writers, b"first", &opts).unwrap();
        write_chunk(&mut writers, b"second", &opts).unwrap();
        flush_writers(&mut writers, &opts).unwrap();
        assert_eq!(&*good.borrow(), b"firstsecond");
        assert_eq!(writers.len(), 1);
        assert!(f.borrow().contains_key(&roots[0]));
        assert!(!f.borrow().contains_key(&roots[1]));
    }
}
#[test]
fn a_partial_move_keeps_source_for_recovery() {
    let (_dir, one, roots) = fixture();
    fs::create_dir_all(&roots[0]).unwrap();
    fs::write(roots[0].join("card"), b"block").unwrap();
    let f = RefCell::new(BTreeMap::new());
    let mut opts = options(&roots, &f, false, true);
    opts.mode = CopyMode::Move;
    copy_one_file(&one, &opts).unwrap();
    assert!(one.src.exists());
    assert!(roots[1].join(one.rel).exists());
}

#[test]
fn writer_buffers_respect_the_total_cap_and_inflight_reservations() {
    assert_eq!(writer_queue_chunks(1024, 2048, 2).unwrap(), 126);
    assert_eq!(writer_queue_chunks(1024, 2048, 4).unwrap(), 62);
    assert!(writer_queue_chunks(16, 32, 4).is_err());
}

#[test]
fn cooldown_uses_recent_speed_and_keeps_baseline_across_files() {
    let mut state = Cooldown::default();
    let block = 8 * 1024 * 1024;
    for _ in 0..8 {
        assert!(
            state
                .observe(block, Duration::from_millis(10), 64 * 1024 * 1024, 20)
                .is_none()
        );
    }
    let baseline = state.baseline.unwrap();
    // The next file has a slow recent window; the old cumulative mean would dilute it.
    let (recent, kept) = state
        .observe(
            64 * 1024 * 1024,
            Duration::from_secs(5),
            64 * 1024 * 1024,
            20,
        )
        .unwrap();
    assert_eq!(baseline, kept);
    assert!(recent < baseline * 0.1);
    assert_eq!(state.total_bytes, 128 * 1024 * 1024);
}

#[test]
fn stale_partials_remove_only_matching_dead_process_regular_files() {
    let (dir, planned, roots) = fixture();
    let dest = roots[1].join(&planned.rel);
    fs::create_dir_all(dest.parent().unwrap()).unwrap();
    let parent = dest.parent().unwrap();
    let dead = parent.join(".one.bin.ditcopy-2147483647-1.partial");
    let live = parent.join(format!(".one.bin.ditcopy-{}-2.partial", std::process::id()));
    let other = parent.join(".other.bin.ditcopy-2147483647-1.partial");
    let malformed = parent.join(".one.bin.ditcopy-2147483647-x.partial");
    for p in [&dead, &live, &other, &malformed] {
        fs::write(p, b"old").unwrap();
    }
    #[cfg(unix)]
    let symlink = parent.join(".one.bin.ditcopy-2147483647-8.partial");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&other, &symlink).unwrap();
    let failures = RefCell::new(BTreeMap::new());
    let opts = options(&roots, &failures, false, true);
    assert_eq!(
        clean_stale_partials(&dest, &opts).unwrap(),
        vec![dead.clone()]
    );
    assert!(!dead.exists());
    assert!(live.exists() && other.exists() && malformed.exists());
    #[cfg(unix)]
    assert!(symlink.exists());
    let temporary = dir.join(".clip.mov.ditcopy-2147483647-0.partial");
    fs::write(&temporary, b"bad").unwrap();
    rename_verify_err(&temporary);
    assert!(dir.join("clip.mov.ditcopy_verify_err").exists());
    assert!(!temporary.exists());
}

#[test]
fn partial_pid_must_have_the_canonical_spelling() {
    for pid in ["+2147483000", "02147483000", "0", "99999999999"] {
        assert!(partial_identity(Path::new(&format!(".a.txt.ditcopy-{pid}-1.partial"))).is_none());
    }
    assert_eq!(
        partial_identity(Path::new(".a.txt.ditcopy-2147483000-1.partial")),
        Some(("a.txt".into(), 2147483000))
    );
}
