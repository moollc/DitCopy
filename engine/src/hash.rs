use crate::events::Phase;
use anyhow::{Context, Result};
use clap::ValueEnum;
use md5::{Digest, Md5};
use sha2::Sha256;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use xxhash_rust::xxh3::Xxh3;
use xxhash_rust::xxh64::Xxh64;

pub const CHUNK_SIZE: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq, Default)]
pub enum HashAlgo {
    #[default]
    Xxh3,
    Xxh64,
    Md5,
    Sha256,
}

impl HashAlgo {
    pub fn as_str(self) -> &'static str {
        match self {
            HashAlgo::Xxh3 => "xxh3",
            HashAlgo::Xxh64 => "xxh64",
            HashAlgo::Md5 => "md5",
            HashAlgo::Sha256 => "sha256",
        }
    }
}

pub enum StreamingHasher {
    Xxh3(Box<Xxh3>),
    Xxh64(Xxh64),
    Md5(Md5),
    Sha256(Sha256),
}

impl StreamingHasher {
    pub fn new(algo: HashAlgo) -> Self {
        match algo {
            HashAlgo::Xxh3 => StreamingHasher::Xxh3(Box::new(Xxh3::new())),
            HashAlgo::Xxh64 => StreamingHasher::Xxh64(Xxh64::new(0)),
            HashAlgo::Md5 => StreamingHasher::Md5(Md5::new()),
            HashAlgo::Sha256 => StreamingHasher::Sha256(Sha256::new()),
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        match self {
            StreamingHasher::Xxh3(h) => h.update(data),
            StreamingHasher::Xxh64(h) => h.update(data),
            StreamingHasher::Md5(h) => h.update(data),
            StreamingHasher::Sha256(h) => h.update(data),
        }
    }

    pub fn finalize(self) -> String {
        match self {
            StreamingHasher::Xxh3(h) => format!("{:016x}", h.digest()),
            StreamingHasher::Xxh64(h) => format!("{:016x}", h.digest()),
            StreamingHasher::Md5(h) => {
                let d = h.finalize();
                hex_bytes(&d)
            }
            StreamingHasher::Sha256(h) => {
                let d = h.finalize();
                hex_bytes(&d)
            }
        }
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn hash_reader(reader: impl Read, algo: HashAlgo) -> Result<(String, u64)> {
    hash_reader_progress(reader, algo, None)
}

fn hash_reader_progress(
    mut reader: impl Read,
    algo: HashAlgo,
    phase: Option<&Phase>,
) -> Result<(String, u64)> {
    hash_reader_progress_at(&mut reader, algo, phase, 0)
}

fn hash_reader_progress_at(
    mut reader: impl Read,
    algo: HashAlgo,
    phase: Option<&Phase>,
    offset: u64,
) -> Result<(String, u64)> {
    let mut hasher = StreamingHasher::new(algo);
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
        if let Some(phase) = phase {
            phase.progress(offset.saturating_add(total));
        }
    }
    Ok((hasher.finalize(), total))
}

pub fn hash_file(path: &Path, algo: HashAlgo) -> Result<(String, u64)> {
    let f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    hash_reader(f, algo)
}

/// Phase starts before opening the file, so a blocked open also heartbeats.
pub fn hash_file_phase(
    path: &Path,
    algo: HashAlgo,
    phase: &'static str,
    source: &Path,
    destination: Option<&Path>,
    total: u64,
) -> Result<(String, u64)> {
    let progress = Phase::start(phase, Some(source), destination, total);
    let f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let result = hash_reader_progress(f, algo, Some(&progress))?;
    progress.finish();
    Ok(result)
}

pub fn hash_file_phase_at(
    path: &Path,
    algo: HashAlgo,
    phase: &Phase,
    offset: u64,
) -> Result<(String, u64)> {
    let f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    hash_reader_progress_at(f, algo, Some(phase), offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_hash_matches_across_chunk_boundaries() {
        let data = vec![73; CHUNK_SIZE + 123];
        for algo in [
            HashAlgo::Xxh3,
            HashAlgo::Xxh64,
            HashAlgo::Md5,
            HashAlgo::Sha256,
        ] {
            let (digest, bytes) = hash_reader(&data[..], algo).unwrap();
            let mut expected = StreamingHasher::new(algo);
            expected.update(&data);
            assert_eq!(digest, expected.finalize());
            assert_eq!(bytes, data.len() as u64);
        }
    }
}
