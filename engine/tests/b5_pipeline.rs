#![cfg(feature = "test-hooks")]
use std::{fs, process::Command};
#[test]
fn bounded_pipeline_allows_fast_writer_lead_and_isolates_failure() {
    let root = std::path::Path::new("/private/tmp/ditcopy-test-b5-fix1/unit");
    fs::create_dir_all(root.join("source")).unwrap();
    fs::File::create(root.join("source/clip.bin"))
        .unwrap()
        .set_len(48 * 1024 * 1024)
        .unwrap();
    let fast = root.join("fast");
    let slow = root.join("slow");
    let run = |fail: bool| {
        Command::new(env!("CARGO_BIN_EXE_ditcopy_engine"))
            .args(["copy", "--src"])
            .arg(root.join("source"))
            .arg("--dest")
            .arg(&fast)
            .arg("--dest")
            .arg(&slow)
            .args(["--mode", "force", "--verify", "true", "--nonstop"])
            .env("DITCOPY_TEST_DEST", &slow)
            .env("DITCOPY_TEST_BPS", "16777216")
            .env(
                "DITCOPY_TEST_FAIL_AFTER",
                if fail { "16777216" } else { "0" },
            )
            .output()
            .unwrap()
    };
    let ok = run(false);
    assert!(ok.status.success());
    let diagnostics = String::from_utf8(ok.stderr).unwrap();
    println!("{}", diagnostics);
    let rows: Vec<serde_json::Value> = diagnostics
        .lines()
        .filter_map(|l| l.strip_prefix("B5_TEST "))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let f = rows
        .iter()
        .find(|v| v["destination"] == fast.to_str().unwrap())
        .unwrap();
    let s = rows
        .iter()
        .find(|v| v["destination"] == slow.to_str().unwrap())
        .unwrap();
    // This file fits the queue budget, so the fast writer must finish well
    // before the slow sink. Sustained pressure beyond the cap is tested separately.
    assert!(f["seconds"].as_f64().unwrap() < s["seconds"].as_f64().unwrap() * 0.8);
    assert!(s["seconds"].as_f64().unwrap() >= 2.9);
    let failed = run(true);
    assert!(!failed.status.success());
    let out = String::from_utf8(failed.stdout).unwrap();
    let done: serde_json::Value = out
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find(|v| v["type"] == "done")
        .unwrap();
    assert_eq!(done["source_errors"], 0);
    assert!(
        done["completed_destinations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == fast.to_str().unwrap())
    );
    assert!(
        done["failed_destinations"]
            .get(slow.to_str().unwrap())
            .is_some()
    );
    assert!(
        done["failed_destinations"][slow.to_str().unwrap()]
            .as_str()
            .unwrap()
            .contains("injected destination write failure")
    );
    assert_eq!(
        fs::metadata(fast.join("source/clip.bin")).unwrap().len(),
        48 * 1024 * 1024
    );
    // The previous complete copy stays untouched; the failed overwrite is partial
    // only under its temporary name, never under clip.bin.
    assert_eq!(
        fs::metadata(slow.join("source/clip.bin")).unwrap().len(),
        48 * 1024 * 1024
    );
    assert!(
        fs::read_dir(slow.join("source"))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.path().extension().is_some_and(|v| v == "partial"))
    );

    println!(
        "PASS bounded fast writer lead; partial failure isolated; healthy destination verified"
    );
}

#[test]
fn same_disk_work_plan_matches_its_serial_streaming_passes() {
    let root = std::path::Path::new("/private/tmp/ditcopy-test-b5-fix1/plan");
    fs::create_dir_all(root.join("source")).unwrap();
    fs::write(root.join("source/one.bin"), b"data").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_ditcopy_engine"))
        .arg("copy")
        .arg("--src")
        .arg(root.join("source"))
        .arg("--dest")
        .arg(root.join("a"))
        .arg("--dest")
        .arg(root.join("b"))
        .args(["--disk-mode", "same", "--verify", "true"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let start: serde_json::Value = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .find(|v| v["type"] == "start")
        .unwrap();
    assert_eq!(start["work_read_bytes"], 0);
    assert_eq!(start["work_copy_bytes"], 8);
    assert_eq!(start["work_verify_bytes"], 8);
}
