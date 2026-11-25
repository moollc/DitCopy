use anyhow::{Context, Result};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::Instant,
};
pub fn run(dest: &Path, id: &str) -> Result<serde_json::Value> {
    anyhow::ensure!(
        !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "invalid probe identifier"
    );
    fs::create_dir_all(dest)?;
    let path = dest.join(format!(".ditcopy-speed-probe-{id}.tmp"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&path)?;
    let result = (|| -> Result<serde_json::Value> {
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            anyhow::ensure!(
                unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, 1) } == 0,
                "cache bypass refused: {}",
                std::io::Error::last_os_error()
            );
        }
        if cfg!(not(any(target_os = "macos", target_os = "linux"))) {
            anyhow::bail!("uncached drive probe is available only on macOS and Linux");
        }
        let mut block = vec![0x5a; 4 * 1024 * 1024];
        let started = Instant::now();
        for _ in 0..16 {
            file.write_all(&block)?;
        }
        file.sync_all()?;
        let write_seconds = started.elapsed().as_secs_f64();
        #[cfg(target_os = "linux")]
        {
            // Linux has no per-file cache bypass that needs no alignment, so drop the cached pages after the write.
            use std::os::fd::AsRawFd;
            let code =
                unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
            anyhow::ensure!(code == 0, "cache drop refused: error {code}");
        }
        file.seek(SeekFrom::Start(0))?;
        let started = Instant::now();
        for _ in 0..16 {
            file.read_exact(&mut block)?;
        }
        let read_seconds = started.elapsed().as_secs_f64();
        Ok(
            serde_json::json!({"destination":dest,"bytes":64*1024*1024,"writeBps":(64.0*1024.0*1024.0)/write_seconds.max(0.001),"readBps":(64.0*1024.0*1024.0)/read_seconds.max(0.001),"cacheBypass":true}),
        )
    })();
    drop(file);
    fs::remove_file(&path).context("remove drive speed probe")?;
    result
}
