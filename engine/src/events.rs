//! Additive JSONL envelope and bounded in-loop telemetry.
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
#[cfg(not(test))]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

static EVENTS: OnceLock<Mutex<Events>> = OnceLock::new();
const CADENCE: Duration = Duration::from_millis(250);
const FILE_DETAIL_BYTES: u64 = 8 * 1024 * 1024;

struct Active {
    phase: &'static str,
    file: Option<String>,
    destination: Option<String>,
    bytes: u64,
    total: u64,
    started: Instant,
    last_progress: Instant,
    visible: bool,
}

#[derive(Default)]
struct DestinationSample {
    bytes: u64,
    elapsed: Duration,
    written: u64,
    verified: u64,
    current_written: u64,
    current_verified: u64,
    status: &'static str,
    last_error: Option<String>,
}

#[derive(Default)]
struct WorkSample {
    bytes: u64,
    elapsed: Duration,
}

struct Events {
    enabled: bool,
    job: String,
    started: Instant,
    sequence: u64,
    last_event: Instant,
    last_aggregate: Option<Instant>,
    aggregate: Option<Value>,
    file_size: u64,
    destinations: BTreeMap<String, DestinationSample>,
    last_speed_sample: Option<Instant>,
    speed_baselines: BTreeMap<String, (u64, Instant)>,
    active: Option<Active>,
    work: BTreeMap<&'static str, WorkSample>,
    #[cfg(test)]
    captured: Vec<Value>,
}

impl Events {
    fn new(enabled: bool, job: String, now: Instant) -> Self {
        Self {
            enabled,
            job,
            started: now,
            sequence: 0,
            last_event: now,
            last_aggregate: None,
            aggregate: None,
            file_size: 0,
            destinations: BTreeMap::new(),
            last_speed_sample: None,
            speed_baselines: BTreeMap::new(),
            active: None,
            work: BTreeMap::new(),
            #[cfg(test)]
            captured: Vec::new(),
        }
    }

    fn send(&mut self, mut value: Value, now: Instant) {
        if !self.enabled {
            return;
        }
        self.sequence += 1;
        let status = value.get("status").cloned().unwrap_or_else(|| {
            json!(match value["type"].as_str() {
                Some("error") => "failed",
                Some("warning") => "warning",
                Some("done") if value["ok"] == false => "failed",
                Some("done") => "completed",
                _ => "running",
            })
        });
        let error = value
            .get("error")
            .cloned()
            .or_else(|| value.get("message").cloned())
            .unwrap_or(Value::Null);
        let mut envelope = json!({
            "schemaVersion": 1, "sequence": self.sequence, "jobId": self.job,
            "attemptId": null, "passId": null,
            "timestampUtc": chrono::Utc::now().to_rfc3339(),
            "elapsedMonotonicMs": now.duration_since(self.started).as_millis() as u64,
            "phase": null, "fileId": null, "destinationId": null,
            "bytesDone": null, "bytesTotal": null,
            "phaseRateBps": null, "phaseElapsedMs": null,
            "status": status, "error": error,
        });
        if let Some(a) = &self.active {
            // Hidden small-file work is not promoted by unrelated legacy events.
            if a.visible && value["type"] != "progress" {
                let elapsed = now.duration_since(a.started);
                envelope["phase"] = json!(a.phase);
                envelope["fileId"] = json!(a.file);
                envelope["destinationId"] = json!(a.destination);
                envelope["bytesDone"] = json!(a.bytes);
                envelope["bytesTotal"] = json!(a.total);
                envelope["phaseElapsedMs"] = json!(elapsed.as_millis() as u64);
                envelope["phaseRateBps"] =
                    json!(a.bytes as f64 / elapsed.as_secs_f64().max(0.000001));
            }
        }
        if matches!(
            value["type"].as_str(),
            Some("progress" | "phase" | "phase_progress" | "done")
        ) {
            envelope["destinationStates"] = json!(
                self.destinations
                    .iter()
                    .map(|(id, s)| json!({
                        "destinationId": id,
                        "bytesWritten": s.written,
                        "bytesVerified": s.verified,
                        "currentBytesWritten": s.current_written,
                        "currentBytesVerified": s.current_verified,
                        "status": if s.status.is_empty() { "pending" } else { s.status },
                        "lastError": s.last_error,
                    }))
                    .collect::<Vec<_>>()
            );
            let mut done = serde_json::Map::new();
            let mut rates = serde_json::Map::new();
            for (phase, sample) in &self.work {
                done.insert(phase.to_string(), json!(sample.bytes));
                if !sample.elapsed.is_zero() && sample.bytes > 0 {
                    rates.insert(
                        phase.to_string(),
                        json!(sample.bytes as f64 / sample.elapsed.as_secs_f64()),
                    );
                }
            }
            if let Some(active) = &self.active
                && matches!(
                    active.phase,
                    "copying"
                        | "reading_source"
                        | "rechecking_source"
                        | "resume_validation"
                        | "verifying_destination"
                )
            {
                let sample = self.work.get(active.phase);
                // A completed phase was already committed before its final event.
                if value["status"] != "completed" {
                    done.insert(
                        active.phase.to_string(),
                        json!(sample.map_or(0, |s| s.bytes) + active.bytes),
                    );
                }
            }
            envelope["workDoneByPhase"] = Value::Object(done);
            envelope["workRatesBps"] = Value::Object(rates);
        }
        envelope["verified_bytes"] =
            json!(self.destinations.values().map(|s| s.verified).sum::<u64>());
        if value["type"] == "progress" {
            let sampled_count = self
                .destinations
                .values()
                .filter(|sample| sample.bytes > 0 && !sample.elapsed.is_zero())
                .count();
            let slowest = self
                .destinations
                .iter()
                .filter(|(_, sample)| sample.bytes > 0 && !sample.elapsed.is_zero())
                .min_by(|(_, a), (_, b)| {
                    let ar = a.bytes as f64 / a.elapsed.as_secs_f64();
                    let br = b.bytes as f64 / b.elapsed.as_secs_f64();
                    ar.total_cmp(&br)
                });
            envelope["destinationCount"] = json!(self.destinations.len());
            envelope["slowestDestinationId"] = if sampled_count > 1 {
                json!(slowest.map(|(id, _)| id))
            } else {
                Value::Null
            };
            envelope["slowestDestinationRateBps"] = if sampled_count > 1 {
                json!(slowest.map(|(_, sample)| sample.bytes as f64 / sample.elapsed.as_secs_f64()))
            } else {
                Value::Null
            };
        }
        value
            .as_object_mut()
            .expect("event object")
            .extend(envelope.as_object().expect("envelope object").clone());
        #[cfg(test)]
        self.captured.push(value.clone());
        #[cfg(not(test))]
        {
            // Serialize once, rather than writing each JSON token separately.
            if let Ok(mut line) = serde_json::to_vec(&value) {
                line.push(b'\n');
                let stdout = std::io::stdout();
                let mut out = stdout.lock();
                let _ = out.write_all(&line);
                let _ = out.flush();
            }
        }
        self.last_event = now;
    }

    fn start_phase(
        &mut self,
        phase: &'static str,
        file: Option<&Path>,
        destination: Option<&Path>,
        total: u64,
        now: Instant,
    ) {
        let visible =
            file.is_none() || total >= FILE_DETAIL_BYTES || self.file_size >= FILE_DETAIL_BYTES;
        self.active = Some(Active {
            phase,
            file: file.map(|p| p.to_string_lossy().into_owned()),
            destination: destination.map(|p| p.to_string_lossy().into_owned()),
            bytes: 0,
            total,
            started: now,
            last_progress: now,
            visible,
        });
        if let Some(destination) = destination
            && let Some((_, state)) = self
                .destinations
                .iter_mut()
                .find(|(root, _)| Path::new(destination).starts_with(Path::new(root.as_str())))
        {
            if state.last_error.is_none() {
                state.status = if phase == "verifying_destination" {
                    "verifying"
                } else if phase == "copying" {
                    "copying"
                } else {
                    state.status
                };
            }
            state.current_verified = 0;
            if phase == "copying" {
                state.current_written = 0;
            }
        }
        if visible {
            self.send(json!({"type": "phase", "status": "running"}), now);
        }
    }

    fn promote(&mut self, now: Instant) {
        if let Some(a) = &mut self.active
            && !a.visible
            && now.duration_since(a.started) >= CADENCE
        {
            a.visible = true;
            self.send(json!({"type": "phase", "status": "running"}), now);
        }
    }

    fn aggregate_progress(&mut self, now: Instant) {
        if self
            .last_aggregate
            .is_some_and(|last| now.duration_since(last) < CADENCE)
        {
            return;
        }
        if let Some(value) = self.aggregate.clone() {
            self.last_aggregate = Some(now);
            self.send(value, now);
        }
    }

    fn progress(&mut self, bytes: u64, now: Instant) {
        if let Some(a) = &mut self.active {
            a.bytes = bytes;
        }
        let active = self
            .active
            .as_ref()
            .map(|a| (a.phase, a.destination.clone(), a.bytes));
        if let Some(("verifying_destination", Some(destination), bytes)) = active
            && let Some((_, state)) = self
                .destinations
                .iter_mut()
                .find(|(root, _)| Path::new(&destination).starts_with(Path::new(root.as_str())))
        {
            state.current_verified = bytes;
        }
        self.promote(now);
        if let Some(a) = &mut self.active
            && a.visible
            && now.duration_since(a.last_progress) >= CADENCE
        {
            a.last_progress = now;
            self.send(json!({"type": "phase_progress"}), now);
        }
        self.aggregate_progress(now);
    }

    fn heartbeat(&mut self, now: Instant) {
        self.promote(now);
        if self.active.as_ref().is_some_and(|a| a.visible)
            && now.duration_since(self.last_event) >= Duration::from_secs(1)
        {
            self.send(json!({"type": "heartbeat"}), now);
        }
    }

    fn end_phase(&mut self, completed: bool, now: Instant) {
        self.promote(now);
        if completed
            && let Some(a) = &self.active
            && matches!(
                a.phase,
                "copying"
                    | "reading_source"
                    | "rechecking_source"
                    | "resume_validation"
                    | "verifying_destination"
            )
        {
            let sample = self.work.entry(a.phase).or_default();
            sample.bytes += a.bytes;
            sample.elapsed += now.duration_since(a.started);
        }
        // Failures are attributed at the actual destination operation, never to
        // every writer sharing a source-scoped phase.
        if self.active.as_ref().is_some_and(|a| a.visible) {
            let status = if completed { "completed" } else { "failed" };
            let error = if completed {
                None
            } else {
                Some("operation failed; see following file/error event")
            };
            self.send(
                json!({"type": "phase", "status": status, "error": error}),
                now,
            );
        }
        self.active = None;
    }
}

pub fn init(job: String) {
    let enabled = std::env::var("DITCOPY_EVENTS").as_deref() != Ok("0");
    let _ = EVENTS.set(Mutex::new(Events::new(enabled, job, Instant::now())));
    if enabled {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_millis(100));
                let mut e = EVENTS
                    .get()
                    .expect("initialised")
                    .lock()
                    .expect("events lock");
                e.heartbeat(Instant::now());
            }
        });
    }
}

pub fn set_file_size(bytes: u64) {
    if let Some(events) = EVENTS.get() {
        events.lock().expect("events lock").file_size = bytes;
    }
}

pub fn configure_destinations(roots: &[PathBuf]) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        for root in roots {
            e.destinations
                .entry(root.to_string_lossy().into_owned())
                .or_default();
        }
    }
}

pub fn destination_write(root: &Path, bytes: u64, elapsed: Duration) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        if !e.enabled {
            return;
        }
        {
            let sample = e
                .destinations
                .entry(root.to_string_lossy().into_owned())
                .or_default();
            sample.bytes += bytes;
            sample.elapsed += elapsed;
            sample.written += bytes;
            sample.current_written += bytes;
            if sample.last_error.is_none() {
                sample.status = "copying";
            }
        }
        let now = Instant::now();
        if e.last_speed_sample
            .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(2))
        {
            let mut destinations = Vec::new();
            for (id, sample) in &e.destinations {
                let (prior_bytes, prior_at) = e
                    .speed_baselines
                    .get(id)
                    .copied()
                    .unwrap_or((sample.written, now));
                let seconds = now.duration_since(prior_at).as_secs_f64();
                if seconds >= 1.0 {
                    destinations.push(json!({"destination":id,"bytes":sample.written,"speedBps":sample.written.saturating_sub(prior_bytes) as f64 / seconds}));
                }
            }
            let snapshots: Vec<(String, u64)> = e
                .destinations
                .iter()
                .map(|(id, sample)| (id.clone(), sample.written))
                .collect();
            for (id, written) in snapshots {
                e.speed_baselines.insert(id, (written, now));
            }
            e.last_speed_sample = Some(now);
            if !destinations.is_empty() {
                e.send(
                    json!({"type":"speed_sample","destinations":destinations}),
                    now,
                );
            }
        }
    }
}

pub fn finish_speed_samples() {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        if !e.enabled {
            return;
        }
        let now = Instant::now();
        let mut destinations = Vec::new();
        for (id, sample) in &e.destinations {
            let (prior_bytes, prior_at) =
                e.speed_baselines.get(id).copied().unwrap_or((0, e.started));
            let seconds = now.duration_since(prior_at).as_secs_f64();
            if seconds > 0.0 && sample.written > prior_bytes {
                destinations.push(json!({"destination":id,"bytes":sample.written,"speedBps":sample.written.saturating_sub(prior_bytes) as f64 / seconds}));
            }
        }
        if !destinations.is_empty() {
            e.send(
                json!({"type":"speed_sample","destinations":destinations}),
                now,
            );
        }
        let snapshots: Vec<(String, u64)> = e
            .destinations
            .iter()
            .map(|(id, sample)| (id.clone(), sample.written))
            .collect();
        for (id, written) in snapshots {
            e.speed_baselines.insert(id, (written, now));
        }
        e.last_speed_sample = Some(now);
    }
}

pub fn destination_begin(root: &Path) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        let state = e
            .destinations
            .entry(root.to_string_lossy().into_owned())
            .or_default();
        state.current_written = 0;
        state.current_verified = 0;
        if state.last_error.is_none() {
            state.status = "copying";
        }
    }
}

pub fn destination_copied(root: &Path) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        if let Some(state) = e.destinations.get_mut(&root.to_string_lossy().into_owned())
            && state.last_error.is_none()
        {
            state.status = "copied";
        }
    }
}

pub fn destination_verified(root: &Path, bytes: u64) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        if let Some(state) = e.destinations.get_mut(&root.to_string_lossy().into_owned()) {
            state.verified += bytes;
            state.current_verified = bytes;
            if state.last_error.is_none() {
                state.status = "verified";
            }
        }
    }
}

pub fn destination_failed(root: &Path, message: impl Into<String>) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        if let Some(state) = e.destinations.get_mut(&root.to_string_lossy().into_owned()) {
            state.status = "failed";
            if state.last_error.is_none() {
                state.last_error = Some(message.into());
            }
        }
    }
}

pub fn emit<T: Serialize>(event: &T) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        if !e.enabled {
            return;
        }
        match serde_json::to_value(event) {
            Ok(v) => e.send(v, Instant::now()),
            Err(err) => eprintln!("json serialize error: {err}"),
        }
    }
}

pub fn emit_progress<T: Serialize>(event: &T) {
    if let Some(events) = EVENTS.get() {
        let mut e = events.lock().expect("events lock");
        if !e.enabled {
            return;
        }
        if let Ok(value) = serde_json::to_value(event) {
            e.aggregate = Some(value);
        }
        e.aggregate_progress(Instant::now());
    }
}

/// Only one operation is active in this serial engine. Complete explicitly;
/// early returns clear the operation and emit failed when detail is visible.
pub struct Phase {
    enabled: bool,
    completed: bool,
}
impl Phase {
    pub fn start(
        phase: &'static str,
        file: Option<&Path>,
        destination: Option<&Path>,
        total: u64,
    ) -> Self {
        let mut enabled = false;
        if let Some(events) = EVENTS.get() {
            let mut e = events.lock().expect("events lock");
            enabled = e.enabled;
            if enabled {
                e.start_phase(phase, file, destination, total, Instant::now());
            }
        }
        Self {
            enabled,
            completed: false,
        }
    }
    pub fn progress(&self, bytes: u64) {
        if !self.enabled {
            return;
        }
        EVENTS
            .get()
            .expect("initialised")
            .lock()
            .expect("events lock")
            .progress(bytes, Instant::now());
    }
    pub fn finish(mut self) {
        self.completed = true;
    }
}
impl Drop for Phase {
    fn drop(&mut self) {
        if self.enabled {
            EVENTS
                .get()
                .expect("initialised")
                .lock()
                .expect("events lock")
                .end_phase(self.completed, Instant::now());
        }
    }
}

#[cfg(test)]
mod tests;
