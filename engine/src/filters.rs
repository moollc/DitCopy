use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::Path;
use std::time::SystemTime;

#[derive(Debug)]
pub struct Filters {
    include: Option<GlobSet>,
    exclude: Option<GlobSet>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub from_date: Option<u32>,
    pub to_date: Option<u32>,
}

impl Filters {
    pub fn new(
        include: Option<&str>,
        exclude: Option<&str>,
        min_size: Option<u64>,
        max_size: Option<u64>,
        from_date: Option<&str>,
        to_date: Option<&str>,
    ) -> Result<Self> {
        Ok(Self {
            include: build_globset(include)?,
            exclude: build_globset(exclude)?,
            min_size,
            max_size,
            from_date: parse_yyyymmdd(from_date)?,
            to_date: parse_yyyymmdd(to_date)?,
        })
    }

    /// Returns Ok(()) if the file passes filters, else Err reason.
    pub fn check(&self, rel_fwd: &str, size: u64, mtime: Option<SystemTime>) -> Result<(), String> {
        if let Some(set) = &self.include
            && !path_matches(set, rel_fwd)
        {
            return Err("filtered".into());
        }
        if let Some(set) = &self.exclude
            && path_matches(set, rel_fwd)
        {
            return Err("filtered".into());
        }
        if let Some(min) = self.min_size
            && size < min
        {
            return Err("filtered".into());
        }
        if let Some(max) = self.max_size
            && size > max
        {
            return Err("filtered".into());
        }
        if self.from_date.is_some() || self.to_date.is_some() {
            let Some(mt) = mtime else {
                return Err("filtered".into());
            };
            let day = mtime_yyyymmdd(mt);
            if let Some(from) = self.from_date
                && day < from
            {
                return Err("filtered".into());
            }
            if let Some(to) = self.to_date
                && day > to
            {
                return Err("filtered".into());
            }
        }
        Ok(())
    }
}

fn build_globset(spec: Option<&str>) -> Result<Option<GlobSet>> {
    let Some(spec) = spec else {
        return Ok(None);
    };
    let spec = spec.trim();
    if spec.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for part in spec.split(';') {
        let pat = part.trim();
        if pat.is_empty() {
            continue;
        }
        builder.add(Glob::new(pat).with_context(|| format!("bad glob '{pat}'"))?);
        // So "*.txt" matches nested rel paths like "src/nested/b.txt"
        if !pat.contains('/') && !pat.starts_with("**/") {
            let nested = format!("**/{pat}");
            builder.add(Glob::new(&nested).with_context(|| format!("bad glob '{nested}'"))?);
        }
    }
    let set = builder.build().context("build globset")?;
    if set.is_empty() {
        Ok(None)
    } else {
        Ok(Some(set))
    }
}

fn path_matches(set: &GlobSet, rel_fwd: &str) -> bool {
    if set.is_match(rel_fwd) {
        return true;
    }
    if let Some(name) = Path::new(rel_fwd).file_name().and_then(|s| s.to_str())
        && set.is_match(name)
    {
        return true;
    }
    false
}

fn parse_yyyymmdd(s: Option<&str>) -> Result<Option<u32>> {
    let Some(s) = s else {
        return Ok(None);
    };
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.len() != 8 || !s.chars().all(|c| c.is_ascii_digit()) {
        return Err(anyhow!("date must be YYYYMMDD, got '{s}'"));
    }
    let n: u32 = s.parse().context("parse YYYYMMDD")?;
    let y = n / 10000;
    let m = (n / 100) % 100;
    let d = n % 100;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 1970 {
        return Err(anyhow!("invalid date '{s}'"));
    }
    Ok(Some(n))
}

fn mtime_yyyymmdd(t: SystemTime) -> u32 {
    let dt: DateTime<Utc> = t.into();
    dt.format("%Y%m%d").to_string().parse().unwrap_or(0)
}

pub fn rel_forward(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}
