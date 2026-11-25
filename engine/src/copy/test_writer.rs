//! Debug feature only: throttle and fail exactly one destination without hardware.
use std::{
    fs::File,
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};
pub(super) struct Writer {
    file: File,
    rate: u64,
    stall_ms: u64,
    drop_after: u64,
    drop_bps: u64,
    fail_after: u64,
    bytes: u64,
    started: Instant,
    root: String,
}
impl Writer {
    pub(super) fn from_env(file: File, root: &Path) -> Self {
        let selected = std::env::var_os("DITCOPY_TEST_DEST").is_some_and(|p| Path::new(&p) == root);
        let setting = |name| {
            if selected {
                std::env::var(name)
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0)
            } else {
                0
            }
        };
        Self {
            file,
            rate: setting("DITCOPY_TEST_BPS"),
            stall_ms: setting("DITCOPY_TEST_STALL_MS"),
            drop_after: setting("DITCOPY_TEST_DROP_AFTER"),
            drop_bps: setting("DITCOPY_TEST_DROP_BPS"),
            fail_after: setting("DITCOPY_TEST_FAIL_AFTER"),
            bytes: 0,
            started: Instant::now(),
            root: root.display().to_string(),
        }
    }
}
impl Write for Writer {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if self.stall_ms > 0 {
            std::thread::sleep(Duration::from_millis(self.stall_ms));
            self.stall_ms = 0;
        }
        if self.fail_after > 0 && self.bytes >= self.fail_after {
            eprintln!(
                "B5_TEST {}",
                serde_json::json!({"destination":self.root,"bytes":self.bytes,"seconds":self.started.elapsed().as_secs_f64(),"failed":true})
            );
            return Err(io::Error::other("injected destination write failure"));
        }
        let n = if self.fail_after > 0 {
            data.len().min((self.fail_after - self.bytes) as usize)
        } else {
            data.len()
        };
        let write_started = Instant::now();
        let n = self.file.write(&data[..n])?;
        self.bytes += n as u64;
        let rate = if self.drop_after > 0 && self.bytes > self.drop_after {
            self.drop_bps
        } else {
            self.rate
        };
        if rate > 0 {
            let due = Duration::from_secs_f64(n as f64 / rate as f64);
            if let Some(wait) = due.checked_sub(write_started.elapsed()) {
                std::thread::sleep(wait);
            }
        }
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()?;
        eprintln!(
            "B5_TEST {}",
            serde_json::json!({"destination":self.root,"bytes":self.bytes,"seconds":self.started.elapsed().as_secs_f64(),"finished":true})
        );
        Ok(())
    }
}
