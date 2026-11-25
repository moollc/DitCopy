use super::*;

fn state() -> (Events, Instant) {
    let now = Instant::now();
    (Events::new(true, "fixture".into(), now), now)
}

#[test]
fn envelope_preserves_legacy_values_and_orders_events() {
    let (mut e, now) = state();
    e.send(
        json!({"type": "file", "path": "clip", "bytes": 19, "status": "copied", "error": null}),
        now,
    );
    e.send(
        json!({"type": "warning", "message": "checkpoint unavailable"}),
        now + CADENCE,
    );
    let first = &e.captured[0];
    for field in [
        "schemaVersion",
        "sequence",
        "jobId",
        "attemptId",
        "passId",
        "timestampUtc",
        "elapsedMonotonicMs",
        "type",
        "phase",
        "fileId",
        "destinationId",
        "bytesDone",
        "bytesTotal",
        "status",
        "error",
        "phaseRateBps",
        "phaseElapsedMs",
    ] {
        assert!(first.get(field).is_some(), "missing {field}");
    }
    assert_eq!(first["status"], "copied");
    assert_eq!(first["bytes"], 19);
    assert_eq!(first["sequence"], 1);
    assert_eq!(first["jobId"], "fixture");
    assert!(chrono::DateTime::parse_from_rfc3339(first["timestampUtc"].as_str().unwrap()).is_ok());
    assert_eq!(e.captured[1]["sequence"], 2);
    assert_eq!(e.captured[1]["elapsedMonotonicMs"], 250);
    assert_eq!(e.captured[1]["status"], "warning");
}

#[test]
fn phase_and_aggregate_cadence_are_independent_and_bounded() {
    let (mut e, now) = state();
    e.start_phase(
        "copying",
        Some(Path::new("clip")),
        None,
        FILE_DETAIL_BYTES,
        now,
    );
    e.aggregate = Some(json!({"type": "progress", "copied_files": 0}));
    for ms in 0..1000 {
        e.progress(ms, now + Duration::from_millis(ms));
    }
    assert_eq!(
        e.captured
            .iter()
            .filter(|v| v["type"] == "phase_progress")
            .count(),
        3
    );
    assert_eq!(
        e.captured
            .iter()
            .filter(|v| v["type"] == "progress")
            .count(),
        4
    );
}

#[test]
fn fast_small_files_emit_no_phase_pairs() {
    let (mut e, now) = state();
    e.start_phase("copying", Some(Path::new("small")), None, 4096, now);
    e.progress(4096, now + Duration::from_millis(1));
    e.end_phase(true, now + Duration::from_millis(2));
    assert!(e.captured.is_empty());
    assert!(e.active.is_none());
}

#[test]
fn slow_small_phase_promotes_after_threshold_and_retains_actual_elapsed() {
    let (mut e, now) = state();
    e.start_phase("copying", Some(Path::new("small")), None, 4096, now);
    e.progress(0, now + Duration::from_millis(249));
    assert!(e.captured.is_empty());
    e.progress(4096, now + CADENCE);
    e.end_phase(true, now + Duration::from_millis(251));
    assert_eq!(e.captured[0]["type"], "phase");
    assert_eq!(e.captured[0]["phaseElapsedMs"], 250);
    assert_eq!(e.captured.last().unwrap()["status"], "completed");
}

#[test]
fn failed_phase_reports_failure_and_clears_active_context() {
    let (mut e, now) = state();
    e.start_phase(
        "copying",
        Some(Path::new("clip")),
        None,
        FILE_DETAIL_BYTES,
        now,
    );
    e.end_phase(false, now + Duration::from_millis(1));
    let failure = e.captured.last().unwrap();
    assert_eq!(failure["status"], "failed");
    assert!(
        failure["error"]
            .as_str()
            .unwrap()
            .contains("operation failed")
    );
    assert!(e.active.is_none());
    e.send(json!({"type": "done", "ok": false}), now + CADENCE);
    assert_eq!(e.captured.last().unwrap()["phase"], Value::Null);
}

#[test]
fn blocked_small_phase_is_promoted_and_heartbeats_without_inventing_bytes() {
    let (mut e, now) = state();
    e.start_phase("copying", Some(Path::new("small")), None, 4096, now);
    e.heartbeat(now + CADENCE);
    e.heartbeat(now + Duration::from_millis(1250));
    assert_eq!(e.captured.last().unwrap()["type"], "heartbeat");
    assert_eq!(e.captured.last().unwrap()["bytesDone"], 0);
}

#[test]
fn aggregate_names_lowest_measured_write_rate_destination() {
    let (mut e, now) = state();
    e.destinations.insert(
        "fast".into(),
        DestinationSample {
            bytes: 1000,
            elapsed: Duration::from_millis(1),
            ..DestinationSample::default()
        },
    );
    e.destinations.insert(
        "slow".into(),
        DestinationSample {
            bytes: 1000,
            elapsed: Duration::from_millis(20),
            ..DestinationSample::default()
        },
    );
    e.aggregate = Some(json!({"type": "progress"}));
    e.aggregate_progress(now);
    assert_eq!(e.captured[0]["destinationCount"], 2);
    assert!(e.captured[0]["phase"].is_null());
    assert_eq!(e.captured[0]["slowestDestinationId"], "slow");
    assert_eq!(e.captured[0]["slowestDestinationRateBps"], 50000.0);
}

#[test]
fn phase_events_keep_destination_written_and_verified_totals_separate() {
    let (mut e, now) = state();
    e.destinations.insert(
        "/dest".into(),
        DestinationSample {
            written: 4096,
            verified: 2048,
            current_written: 1024,
            current_verified: 512,
            status: "verifying",
            ..DestinationSample::default()
        },
    );
    e.send(json!({"type": "phase_progress"}), now);
    let event = e.captured.last().unwrap();
    assert_eq!(event["verified_bytes"], 2048);
    assert_eq!(event["destinationStates"][0]["destinationId"], "/dest");
    assert_eq!(event["destinationStates"][0]["bytesWritten"], 4096);
    assert_eq!(event["destinationStates"][0]["bytesVerified"], 2048);
    assert_eq!(event["destinationStates"][0]["status"], "verifying");
}

#[test]
fn small_successful_phases_feed_work_totals_but_skipped_hashing_does_not() {
    let (mut e, now) = state();
    for (phase, offset) in [
        ("copying", 0),
        ("hashing_skipped_source", 10),
        ("rechecking_source", 20),
    ] {
        e.start_phase(
            phase,
            Some(Path::new("small")),
            None,
            4096,
            now + Duration::from_millis(offset),
        );
        e.progress(4096, now + Duration::from_millis(offset + 1));
        e.end_phase(true, now + Duration::from_millis(offset + 2));
    }
    e.send(json!({"type":"progress"}), now + CADENCE);
    let v = e.captured.last().unwrap();
    assert_eq!(v["workDoneByPhase"]["copying"], 4096);
    assert_eq!(v["workDoneByPhase"]["rechecking_source"], 4096);
    assert!(v["workDoneByPhase"].get("hashing_skipped_source").is_none());
    assert_eq!(v["workRatesBps"]["copying"], 2048000.0);
}

#[test]
fn destination_arrays_are_only_on_snapshot_event_types() {
    let (mut e, now) = state();
    for kind in [
        "start",
        "file",
        "heartbeat",
        "error",
        "progress",
        "phase",
        "phase_progress",
        "done",
    ] {
        e.send(json!({"type":kind}), now);
        let expected = matches!(kind, "progress" | "phase" | "phase_progress" | "done");
        assert_eq!(
            e.captured
                .last()
                .unwrap()
                .get("destinationStates")
                .is_some(),
            expected,
            "{kind}"
        );
    }
}

#[test]
fn destination_failure_is_specific_and_sticky_across_later_files() {
    init("sticky-fixture".into());
    let roots = [
        PathBuf::from("/fixture/good"),
        PathBuf::from("/fixture/bad"),
    ];
    configure_destinations(&roots);
    destination_begin(&roots[0]);
    destination_begin(&roots[1]);
    destination_failed(&roots[1], "create b.bin: is a directory");
    for root in &roots {
        destination_begin(root);
        destination_write(root, 4096, Duration::from_millis(1));
        destination_copied(root);
        destination_verified(root, 4096);
    }
    destination_failed(&roots[1], "a later error");
    let e = EVENTS.get().unwrap().lock().unwrap();
    let good = &e.destinations["/fixture/good"];
    let bad = &e.destinations["/fixture/bad"];
    assert_eq!(good.status, "verified");
    assert!(good.last_error.is_none());
    assert_eq!(bad.status, "failed");
    assert_eq!(
        bad.last_error.as_deref(),
        Some("create b.bin: is a directory")
    );
}
