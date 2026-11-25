#!/usr/bin/env node
"use strict";

/**
 * DitCopy HTTP server — Phase 2+3
 *
 * Cascade: when cascade && dest.length > 1, first engine pass is src→dest[0];
 * on success a second pass runs src→dest[1..] (same original src, not dest[0] as src).
 */

const http = require("http");
const { checkRequest } = require("./host-guard");
const platform = require("./platform");
const fs = require("fs");
const path = require("path");
const { spawn, execFile, execFileSync } = require("child_process");
const { URL } = require("url");
const { safeEstimate: estimateJob } = require("./estimator");
const { observeEstimatorBinding } = require("./estimator-signals");
const destinations = require("./destination-outcomes");
const driveLinks = require("./drive-links");
const speedCauses = require("./speed-diagnosis");
const driveSpeed = require("./drive-speed");
const { restoreFinishedJobs } = require("./history");
const { createDriveEjectService } = require("./drive-eject");

const HOST = "127.0.0.1";
// 34826 spells DITCO on a phone keypad (D3 I4 T8 C2 O6). 8788 was a generic port other local tools could take.
const DEFAULT_PORT = 34826;

function parsePort(raw) {
  if (raw == null || raw === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`DITCOPY_PORT must be a whole number from 1 to 65535, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

const PORT = parsePort(process.env.DITCOPY_PORT);

const ROOT = path.resolve(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const LOGS_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(LOGS_DIR, "reports");
const JOBS_DIR = path.join(ROOT, "jobs");
const PRESETS_DIR = path.join(ROOT, "presets");
const ENGINE =
  process.env.DITCOPY_ENGINE || path.join(ROOT, "engine", "target", "release", platform.engineFileName());
const ACTIVITY_MAX = 200;
const DIAGNOSTICS_MAX = 100;

const volumes = require("./volumes");

const ALL_MODES = [
  "force",
  "noexist",
  "diff",
  "newer",
  "sync",
  "move",
  "delete",
  "verify-only",
];
const DESTRUCTIVE_MODES = new Set(["sync", "move", "delete"]);
const HASH_TYPES = new Set(["xxh3", "xxh64", "md5", "sha256"]);
const SPEED_TYPES = new Set(["full", "autoslow", "90", "50", "10"]);
const DISK_MODES = new Set(["auto", "same", "diff"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".mhl": "application/xml; charset=utf-8",
};

/** @type {Map<string, object>} */
const jobs = new Map();
const driveEject = createDriveEjectService();

/** @type {Set<string>} */
let engineFlags = new Set();

function ensureDirs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

function probeEngineFlags() {
  const found = new Set();
  if (!fs.existsSync(ENGINE)) {
    engineFlags = found;
    return found;
  }
  try {
    const out = execFileSync(ENGINE, ["copy", "--help"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const text = String(out);
    for (const m of text.matchAll(/--([a-z0-9-]+)/gi)) {
      found.add(m[1].toLowerCase());
    }
  } catch (e) {
    const text = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    for (const m of text.matchAll(/--([a-z0-9-]+)/gi)) {
      found.add(m[1].toLowerCase());
    }
  }
  engineFlags = found;
  return found;
}

function engineHas(flag) {
  if (engineFlags.size === 0) return true;
  return engineFlags.has(flag);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function makeJobId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `job-${ts}-${rand}`;
}

function appendJobLog(jobId, event) {
  ensureDirs();
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(path.join(LOGS_DIR, `${jobId}.jsonl`), line, "utf8");
}

function checkpointPath(jobId) {
  return path.join(LOGS_DIR, `${jobId}.checkpoint.json`);
}

function controlPath(jobId) {
  return path.join(LOGS_DIR, `${jobId}.control.json`);
}

function writeCheckpoint(job) {
  const completed = {}, records = new Map();
  for (const ev of job.events) {
    if (ev.type !== "file" || !["copied","verified"].includes(ev.status)) continue;
    const rel=String(ev.path || "").replace(/\\/g,"/");if(!rel)continue;
    const record={bytes:Number(ev.bytes)||0,hash:ev.hash||""};
    if (!Array.isArray(ev.destinations)) { if(!destinations.failures(job).length) completed[rel]=record; continue; }
    const byDest=records.get(rel)||new Map();for(const dest of ev.destinations)byDest.set(destinations.key(dest),record);records.set(rel,byDest);
  }
  for (const [rel,byDest] of records) {
    const recordsForJob=(job.dest||[]).map(d=>byDest.get(destinations.key(d)));
    if(recordsForJob.length && recordsForJob.every(r=>r && r.hash===recordsForJob[0].hash))completed[rel]=recordsForJob[0];
  }
  const payload = { completed, updatedAt: new Date().toISOString(), jobId: job.id };
  fs.writeFileSync(checkpointPath(job.id), JSON.stringify(payload, null, 2), "utf8");
  job.checkpointPath = checkpointPath(job.id);
}

function writeControlRequest(job, action) {
  const file = controlPath(job.id);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${action}\n`, { flag: "w" });
  fs.renameSync(temp, file);
  job.controlPath = file;
}


function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function collectCopiedFiles(job, destination = null) {
  /** @type {Map<string, {path:string,bytes:number,hash:string,status:string}>} */
  const map = new Map();
  for (const ev of job.events) {
    if (ev.type !== "file") continue;
    if (destination && Array.isArray(ev.destinations) && !ev.destinations.some(p=>destinations.key(p)===destinations.key(destination))) continue;
    if (ev.status !== "copied" && ev.status !== "verified" && ev.status !== "ok") continue;
    const rel = String(ev.path || "").replace(/\\/g, "/");
    if (!rel) continue;
    map.set(rel, {
      path: rel,
      bytes: ev.bytes != null ? Number(ev.bytes) : 0,
      hash: ev.hash || "",
      status: ev.status,
    });
  }
  return [...map.values()];
}

function writeMhlForDest(job, destDir, files) {
  const hashType = job.hash || "xxh3";
  const hashTag =
    hashType === "xxh64"
      ? "xxhash64"
      : hashType === "md5"
        ? "md5"
        : hashType === "sha256"
          ? "sha256"
          : "xxhash64";
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<hashlist version="1.1">');
  lines.push("  <creatorinfo>");
  lines.push(`    <tool>DitCopy</tool>`);
  lines.push(`    <jobid>${escapeXml(job.id)}</jobid>`);
  lines.push(`    <created>${escapeXml(new Date().toISOString())}</created>`);
  lines.push(`    <hashformat>${escapeXml(hashType)}</hashformat>`);
  lines.push("  </creatorinfo>");
  for (const f of files) {
    lines.push("  <hash>");
    lines.push(`    <file>${escapeXml(f.path)}</file>`);
    lines.push(`    <size>${Number(f.bytes) || 0}</size>`);
    lines.push(`    <${hashTag}>${escapeXml(f.hash)}</${hashTag}>`);
    lines.push("  </hash>");
  }
  lines.push("</hashlist>");
  lines.push("");

  fs.mkdirSync(destDir, { recursive: true });
  const mhlName = `${job.id}.mhl`;
  const mhlPath = path.join(destDir, mhlName);
  const altPath = path.join(destDir, "DitCopy.mhl");
  const xml = lines.join("\n");
  fs.writeFileSync(mhlPath, xml, "utf8");
  fs.writeFileSync(altPath, xml, "utf8");
  return mhlPath;
}

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function probeDriveLinks(paths) {
  // Link speed reads macOS tools. Elsewhere every drive reports "link speed unknown" instead of failing.
  if (!platform.capabilities().linkSpeed) {
    return Promise.resolve((paths || []).map((destination) => ({ destination, type: "link speed unknown", detail: "", physicalDisks: [], warning: null })));
  }
  return driveLinks.probe(paths);
}

function testDriveSpeed(mount, jobId) { return driveSpeed.testDriveSpeed(mount, jobId, ENGINE); }

function speedDiagnosis(job) { return speedCauses.diagnosis(job, fmtBytes); }

function writeReports(job, files) {
  ensureDirs();
  const htmlPath = path.join(REPORTS_DIR, `${job.id}.html`);
  const txtPath = path.join(REPORTS_DIR, `${job.id}.txt`);
  const summary = job.summary || {};
  const title = `DitCopy report — ${job.id}`;
  const partialPaths = new Set(), partialWarnings = new Map(), cleanupJobs = new Set();
  for (let current = job; current && !cleanupJobs.has(current.id); current = jobs.get(current.resumeFrom)) {
    cleanupJobs.add(current.id);
    for (const event of current.events || []) {
      if (event.type === "partial_cleanup") partialPaths.add(event.path);
      if (event.type === "partial_cleanup_warning") partialWarnings.set(event.path, `${event.path}: ${event.message}`);
    }
  }
  const removedPartials = [...partialPaths];
  const notRemovedPartials = [...partialWarnings.values()];

  const rows = files
    .map(
      (f) =>
        `<tr><td>${escapeXml(f.path)}</td><td>${f.bytes}</td><td class="mono">${escapeXml(f.hash)}</td><td>${escapeXml(f.status)}</td></tr>`
    )
    .join("\n");
  const speedHeaders = (job.dest || []).map((dest) => `<th>${escapeXml(dest)}</th>`).join("");
  const speedRows = (job.speedSamples || []).map((sample) => {
    const cols = (job.dest || []).map((dest) => {
      const item = (sample.destinations || []).find((entry) => destinations.key(entry.destination) === destinations.key(dest));
      return `<td>${item ? `${escapeXml(fmtBytes(item.speedBps))}/s` : "—"}</td>`;
    }).join("");
    return `<tr><td>${escapeXml(sample.timestampUtc || "")}</td>${cols}</tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>${escapeXml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#12141a;color:#e8ecf4;padding:1.5rem;overflow-wrap:anywhere}
h1{font-size:1.25rem} .muted{color:#8b95a8} table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{border:1px solid #2a3140;padding:.4rem .55rem;text-align:left;font-size:13px;overflow-wrap:anywhere;word-break:break-word}
th{background:#1a1e28;color:#8b95a8} .mono{font-family:Menlo,Monaco,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all}
.ok{color:#3ecf8e} .bad{color:#e85d5d}
</style></head><body>
<h1>${escapeXml(title)}</h1>
<p class="muted">${escapeXml(job.finishedAt || "")} · status <strong class="${(job.finalizeErrors.length ? "done_with_errors" : job.reportStatus || job.status) === "done" ? "ok" : "bad"}">${escapeXml((job.finalizeErrors.length ? "done_with_errors" : job.reportStatus || job.status))}</strong></p>
<pre class="mono">mode=${escapeXml(job.mode)} verify=${job.verify} hash=${escapeXml(job.hash || "xxh3")}
src=${escapeXml(JSON.stringify(job.src))}
dest=${escapeXml(JSON.stringify(job.dest))}
drive links:\n${escapeXml(speedCauses.describeLinks(job.driveLinks || []))}
possible_speed_cause=${escapeXml(speedDiagnosis(job))}
${escapeXml(destinations.describe(job))}
copied_files=${summary.copied_files ?? "—"} skipped=${summary.skipped ?? "—"} errors=${summary.errors ?? "—"} bytes=${summary.bytes ?? "—"} elapsed_ms=${summary.elapsed_ms ?? "—"}</pre>
<table><thead><tr><th>Path</th><th>Bytes</th><th>Hash</th><th>Status</th></tr></thead>
<tbody>${rows || "<tr><td colspan=4 class=muted>No file events</td></tr>"}</tbody></table>
<h2>Stale partial files not removed</h2><pre>${notRemovedPartials.length ? notRemovedPartials.map(escapeXml).join("\n") : "None"}</pre>
<h2>Stale partial files removed</h2><pre>${removedPartials.length ? removedPartials.map(escapeXml).join("\n") : "None"}</pre>
<h2>Speed over time by destination</h2><p>${escapeXml(speedDiagnosis(job))}</p>
<table><thead><tr><th>Time</th>${speedHeaders}</tr></thead><tbody>${speedRows || `<tr><td colspan="${(job.dest || []).length + 1}" class="muted">No speed sample reached the sampling interval.</td></tr>`}</tbody></table>
</body></html>
`;

  const txtLines = [
    title,
    `status: ${(job.finalizeErrors.length ? "done_with_errors" : job.reportStatus || job.status)}`,
    `finished: ${job.finishedAt || ""}`,
    `mode: ${job.mode}`,
    `verify: ${job.verify}`,
    `hash: ${job.hash || "xxh3"}`,
    `source folders:\n${(job.src || []).join("\n")}`,
    `destinations:\n${(job.dest || []).join("\n")}`,
    `drive links:\n${speedCauses.describeLinks(job.driveLinks || [])}`,
    `possible speed cause: ${speedDiagnosis(job)}`,
    destinations.describe(job),
    `files copied: ${summary.copied_files ?? "unavailable"}`,
    `files skipped: ${summary.skipped ?? "unavailable"}`,
    `errors: ${summary.errors ?? "unavailable"}`,
    `bytes copied: ${summary.bytes == null ? "unavailable" : fmtBytes(summary.bytes)}`,
    `elapsed: ${summary.elapsed_ms == null ? "unavailable" : (summary.elapsed_ms / 1000).toFixed(3) + " seconds"}`,
    "stale partial files not removed:",
    ...(notRemovedPartials.length ? notRemovedPartials : ["None"]),
    "stale partial files removed:",
    ...(removedPartials.length ? removedPartials : ["None"]),
    "speed samples:",
    ...(job.speedSamples || []).map(sample => `${sample.timestampUtc || ""}: ${(sample.destinations || []).map(d => `${d.destination}: ${fmtBytes(d.speedBps)}/s after ${fmtBytes(d.bytes)}`).join("; ")}`),
    "",
    "path\tbytes\thash\tstatus",
    ...files.map((f) => `${f.path}\t${f.bytes}\t${f.hash}\t${f.status}`),
    "",
  ];

  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(txtPath, txtLines.join("\n"), "utf8");
  return { html: htmlPath, txt: txtPath };
}

function postProcessJob(job) {
  const reports = { html: null, txt: null, mhl: [] };
  job.reports = reports;
  // A failed required output is recorded here. The caller maps any failure to done with errors.
  const failed = (message, e) => {
    const text = `${message}: ${e.message}`;
    job.finalizeErrors.push(text);
    const ev = { type: "error", message: text };
    job.events.push(ev);
    appendJobLog(job.id, ev);
    pushActivity(job, "error", text);
  };
  const files = collectCopiedFiles(job);
  try {
    writeCheckpoint(job);
  } catch (e) {
    failed("checkpoint write failed", e);
  }
  if (job.writeMhl) {
    for (const d of destinations.completed(job)) {
      try {
        reports.mhl.push(writeMhlForDest(job, d, collectCopiedFiles(job, d)));
      } catch (e) {
        failed(`MHL write failed for ${d}`, e);
      }
    }
  }
  if (job.writeReport) {
    try {
      const r = writeReports(job, files);
      reports.html = r.html;
      reports.txt = r.txt;
    } catch (e) {
      failed("report write failed", e);
    }
  }
  return reports;
}

function noteActivity(job) {
  job.lastActivityAt = Date.now();
}

function pushActivity(job, kind, text) {
  job.activitySeq += 1;
  job.activity.push({
    seq: job.activitySeq,
    at: Date.now(),
    kind,
    text: String(text).slice(0, 500),
  });
  if (job.activity.length > ACTIVITY_MAX) {
    job.activity.splice(0, job.activity.length - ACTIVITY_MAX);
  }
}

function ingestStderrLine(job, raw) {
  const line = raw.trim();
  if (!line) return;
  const ev = { type: "stderr", line, at: new Date().toISOString() };
  appendJobLog(job.id, ev);
  job.diagnostics.push({ at: Date.now(), line: line.slice(0, 500) });
  if (job.diagnostics.length > DIAGNOSTICS_MAX) {
    job.diagnostics.splice(0, job.diagnostics.length - DIAGNOSTICS_MAX);
  }
  pushActivity(job, "stderr", line);
}

/** State line from the events that exist today; no estimate of remaining time. */
function liveState(job) {
  switch (job.status) {
    case "done":
      return "Done";
    case "done_with_errors":
      return "Done with errors";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "incomplete":
      return "Incomplete";
    case "queued":
      return "Queued";
    case "pausing":
      return "Pausing after current file";
    case "paused":
      return "Paused";
    case "stopping":
      return "Stopping after current file";
    case "stopped":
      return "Stopped";
    default:
      break;
  }
  if (job.pass === 0) return "Scanning";
  if (job.engineDone) {
    const nextPass = job.cascade && job.dest?.length > 1 && job.pass < 2;
    return nextPass ? "Scanning" : "Finishing";
  }
  return "Copying";
}

function jobPublic(job) {
  return {
    id: job.id,
    status: job.status,
    state: liveState(job),
    pass: job.pass,
    passes: job.cascade && job.dest?.length > 1 ? 2 : 1,
    lastActivityAt: job.lastActivityAt,
    serverNow: Date.now(),
    activity: job.activity,
    diagnostics: job.diagnostics,
    finalizeErrors: job.finalizeErrors,
    src: job.src,
    dest: job.dest,
    mode: job.mode,
    verify: job.verify,
    perfectVerify: job.perfectVerify,
    hash: job.hash,
    include: job.include,
    exclude: job.exclude,
    minSize: job.minSize,
    maxSize: job.maxSize,
    fromDate: job.fromDate,
    toDate: job.toDate,
    speed: job.speed,
    diskMode: job.diskMode,
    driveLinks: job.driveLinks || [],
    speedSamples: job.speedSamples || [],
    speedTestResults: job.speedTestResults || [],
    speedDiagnosis: speedDiagnosis(job),
    nonstop: job.nonstop,
    confirm: job.confirm,
    cascade: job.cascade,
    writeMhl: job.writeMhl,
    writeReport: job.writeReport,
    keepAwake: job.keepAwake,
    resumeFrom: job.resumeFrom,
    resumedBy: job.resumedBy || null,
    retryFailedAvailable: job.status === "done_with_errors" && destinations.failures(job).length > 0 && !job.resumedBy,
    jobName: job.jobName,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    pid: job.pid,
    summary: job.summary,
    error: job.error,
    progress: job.progress,
    estimate: job.estimate || null,
    destination_results: Object.values(job.destinationResults || {}),
    status_detail: destinations.describe(job),
    events: job.events,
    reports: job.reports,
    checkpointPath: job.checkpointPath || null,
    cascadeNote: job.cascade
      ? "Cascade: pass1 src→dest[0]; pass2 same src→dest[1..] on success"
      : null,
    ejectState: job.ejectState || null,
  };
}

async function listVolumes() {
  const entries = await volumes.loadDf({ refresh: true });
  return volumes.listVolumes({ appDir: ROOT, entries });
}

/** The source and destination rules for every way a job arrives. Returns a 400 body or null. */
async function refuseBadJob(fields, { requireVolumeBindings = false } = {}) {
  const entries = await volumes.loadDf({ refresh: true });
  const { errors } = volumes.validateStart(fields, { appDir: ROOT, entries, requireVolumeBindings });
  return errors.length ? { error: errors.join(". "), errors } : null;
}

async function captureJobVolumeBindings(fields) {
  fields.volumeBindings = volumes.captureBindings(
    [...(fields.src || []), ...(fields.dest || [])],
    fields.volumeBindings,
    await volumes.loadDf(),
  );
  return fields;
}

function rebaseVolumePath(input, oldRoot, newRoot) {
  if (!oldRoot || !newRoot) return null;
  const from = path.resolve(oldRoot);
  const target = path.resolve(input);
  const relative = path.relative(from, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return path.resolve(newRoot, relative);
}

async function resumeVolumeCheck(previous) {
  const entries = await volumes.loadDf({ refresh: true });
  const mounted = await volumes.listVolumes({ appDir: ROOT, entries });
  const bindings = new Map((previous.volumeBindings || []).map((b) => [String(b.path), b]));
  const replacements = [];
  for (const target of [...(previous.src || []), ...(previous.dest || [])]) {
    const saved = bindings.get(target);
    const current = volumes.locateVolume(target, entries);
    if (!saved) {
      if (platform.externalMountOf(target)) {
        return { error: `The drive for ${target} has no saved identity. Reconnect it and select it again before resuming.` };
      }
      continue;
    }
    if (!volumes.isVolumeUuidIdentity(saved.identity)) {
      return { error: `The saved drive identity for ${target} has no volume UUID. Choose the source and destination drives again in a new job; this saved checkpoint cannot be resumed safely.` };
    }
    if (current && current.identity === saved.identity) continue;
    const candidate = mounted.find((volume) => volume.identity === saved.identity && !volume.startup);
    if (!candidate) {
      const name = saved.name || path.basename(saved.root || target) || "The drive";
      return { error: `${name} is not connected or has changed; reconnect the original drive and press Resume.` };
    }
    const nextRoot = candidate.root || candidate.path;
    const nextPath = rebaseVolumePath(target, saved.root, nextRoot);
    if (!nextPath) {
      return { error: `The saved path ${target} is outside the recorded volume; choose the drive again before resuming.` };
    }
    if (!replacements.some((item) => item.from === target)) {
      replacements.push({ from: target, to: nextPath, volumeName: candidate.name, root: nextRoot });
    }
  }
  return { replacements };
}

function applyResumeReplacements(previous, replacements) {
  const map = new Map(replacements.map((item) => [item.from, item]));
  const fields = normalizeJobBody({ ...previous, resumeFrom: previous.id });
  fields.src = fields.src.map((p) => map.get(p)?.to || p);
  fields.dest = fields.dest.map((p) => map.get(p)?.to || p);
  fields.volumeBindings = (previous.volumeBindings || []).map((binding) => {
    const replacement = map.get(binding.path);
    return replacement
      ? { ...binding, path: replacement.to, root: replacement.root, name: replacement.volumeName }
      : binding;
  });
  return fields;
}

function markJobResumed(previous, job) {
  previous.resumedBy = job.id;
  const event = { type: "job_resumed", resumedBy: job.id, timestampUtc: new Date().toISOString() };
  previous.events.push(event);
  appendJobLog(previous.id, event);
}

function serveFile(res, filePath, baseDir, extraHeaders) {
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      ...(extraHeaders || {}),
    });
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = decodeURIComponent(rel);
  if (rel.includes("..")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  const filePath = path.join(UI_DIR, rel);
  // A reload always gets the newest page.
  serveFile(res, filePath, UI_DIR, { "Cache-Control": "no-cache" });
}

function serveReports(req, res, pathname) {
  let rel = pathname.replace(/^\/reports\/?/, "");
  rel = decodeURIComponent(rel);
  if (!rel || rel.includes("..")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  const filePath = path.join(REPORTS_DIR, rel);
  serveFile(res, filePath, REPORTS_DIR);
}

function normalizeJobBody(body) {
  const src = Array.isArray(body.src) ? body.src.filter(Boolean) : [];
  const dest = Array.isArray(body.dest) ? body.dest.filter(Boolean) : [];
  const mode = body.mode || "force";
  return {
    src,
    dest,
    mode,
    verify: body.verify !== false,
    perfectVerify: !!body.perfectVerify,
    hash: HASH_TYPES.has(body.hash) ? body.hash : "xxh3",
    include: body.include != null ? String(body.include) : "",
    exclude: body.exclude != null ? String(body.exclude) : "",
    minSize: body.minSize != null && body.minSize !== "" ? Number(body.minSize) : null,
    maxSize: body.maxSize != null && body.maxSize !== "" ? Number(body.maxSize) : null,
    fromDate: body.fromDate || null,
    toDate: body.toDate || null,
    speed: SPEED_TYPES.has(String(body.speed)) ? String(body.speed) : "full",
    diskMode: DISK_MODES.has(body.diskMode) ? body.diskMode : "auto",
    testDriveSpeed: !!body.testDriveSpeed,
    cooldownSeconds: Math.max(0, Number(body.cooldownSeconds) || 0),
    cooldownEveryGb: Math.max(0, Number(body.cooldownEveryGb) || 0),
    cooldownDropPercent: Math.min(99, Math.max(1, Number(body.cooldownDropPercent) || 20)),
    nonstop: body.nonstop === undefined ? true : !!body.nonstop,
    confirm: !!body.confirm,
    cascade: !!body.cascade,
    writeMhl: !!body.writeMhl,
    writeReport: !!body.writeReport,
    keepAwake: !!body.keepAwake,
    resumeFrom: body.resumeFrom || null,
    jobName: body.jobName || null,
    volumeBindings: Array.isArray(body.volumeBindings) ? body.volumeBindings : [],
    requireVolumeBindings: !!body.requireVolumeBindings,
  };
}

function buildEngineArgs(job, srcList, destList) {
  const args = ["copy"];
  for (const s of srcList) args.push("--src", s);
  for (const d of destList) args.push("--dest", d);
  args.push("--mode", job.mode);
  args.push("--verify", job.verify ? "true" : "false");

  if (job.perfectVerify && engineHas("perfect-verify")) args.push("--perfect-verify");
  if (job.hash && job.hash !== "xxh3" && engineHas("hash")) {
    args.push("--hash", job.hash);
  } else if (job.hash && engineHas("hash")) {
    args.push("--hash", job.hash);
  }
  if (job.include && engineHas("include")) args.push("--include", job.include);
  if (job.exclude && engineHas("exclude")) args.push("--exclude", job.exclude);
  if (job.minSize != null && !Number.isNaN(job.minSize) && engineHas("min-size")) {
    args.push("--min-size", String(job.minSize));
  }
  if (job.maxSize != null && !Number.isNaN(job.maxSize) && engineHas("max-size")) {
    args.push("--max-size", String(job.maxSize));
  }
  if (job.fromDate && engineHas("from-date")) args.push("--from-date", String(job.fromDate));
  if (job.toDate && engineHas("to-date")) args.push("--to-date", String(job.toDate));
  if (job.speed && job.speed !== "full" && engineHas("speed")) {
    args.push("--speed", job.speed);
  } else if (job.speed && engineHas("speed")) {
    args.push("--speed", job.speed);
  }
  if (job.diskMode && job.diskMode !== "auto" && engineHas("disk-mode")) {
    args.push("--disk-mode", job.diskMode);
  } else if (job.diskMode && engineHas("disk-mode")) {
    args.push("--disk-mode", job.diskMode);
  }
  if (job.cooldownSeconds > 0 && job.cooldownEveryGb > 0) {
    args.push("--cooldown-seconds", String(job.cooldownSeconds), "--cooldown-every-gb", String(job.cooldownEveryGb), "--cooldown-drop-percent", String(job.cooldownDropPercent));
  }
  if (job.nonstop && engineHas("nonstop")) args.push("--nonstop");
  if (job.confirm && engineHas("confirm")) args.push("--confirm");
  if (engineHas("job-id")) args.push("--job-id", job.id);

  const cp = checkpointPath(job.id);
  if (engineHas("checkpoint")) args.push("--checkpoint", cp);
  if (engineHas("control-file")) args.push("--control-file", controlPath(job.id));

  if (job.resumeFrom) {
    const resumeCp = checkpointPath(job.resumeFrom);
    if (fs.existsSync(resumeCp) && engineHas("resume-checkpoint")) {
      args.push("--resume-checkpoint", resumeCp);
    }
  }

  return args;
}

function ingestStdoutLine(job, line) {
  if (!line) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    ev = { type: "raw", line };
  }
  job.events.push(ev);
  appendJobLog(job.id, ev);
  if (ev.type === "speed_sample") {
    job.speedSamples ||= [];
    job.speedSamples.push(ev);
    if (job.speedSamples.length > 500) job.speedSamples.shift();
  }
  destinations.recordDestinations(job, ev);
  noteActivity(job);
  if (ev.type === "progress") {
    // Merge so the planned totals from the start event survive.
    job.progress = {
      ...(job.progress || {}),
      copied_files: ev.copied_files,
      copied_bytes: ev.copied_bytes,
      current: ev.current,
      speed_bps: ev.speed_bps,
      verified_bytes: ev.verified_bytes,
      destination_states: ev.destinationStates,
      destination_count: ev.destinationCount,
      slowest_destination_id: ev.slowestDestinationId,
      slowest_destination_rate_bps: ev.slowestDestinationRateBps,
    };
    pushActivity(job, "info", `Working on ${ev.current}`);
  } else if (ev.type === "start") {
    job.pass += 1;
    job.engineDone = false;
    job.progress = {
      copied_files: 0,
      copied_bytes: 0,
      done_files: 0,
      done_bytes: 0,
      total_files: ev.files,
      total_bytes: ev.bytes,
      verified_bytes: 0,
      phase: null,
      phase_bytes: null,
      phase_total: null,
      phase_rate_bps: null,
      phase_elapsed_ms: null,
      destination_states: ev.destinationStates || [],
      destination_count: ev.destinationCount || job.dest.length,
      slowest_destination_id: null,
      slowest_destination_rate_bps: null,
    };
    pushActivity(job, "info", `Planned ${ev.files} files, ${fmtBytes(ev.bytes)}`);
  } else if (ev.type === "job_state" && ["paused", "stopped"].includes(ev.state)) {
    job.status = ev.state;
    pushActivity(job, "info", `Job ${ev.state} after current file`);
  } else if (ev.type === "done") {
    job.summary = ev;
    job.engineDone = true;
    job.estimate = estimateJob(job, Date.now());
    pushActivity(job, "info", "Engine reported done");
  } else if (ev.type === "error" || ev.type === "destination_error") {
    job.lastError = ev.message;
    pushActivity(job, "error", ev.message || "error");
  } else if (ev.type === "file") {
    const what = ev.status || "file";
    const why = ev.error ? ` (${ev.error})` : "";
    // Sync cleanup removes destination-only files and empty folders after the planned files.
    // Those records are activity only. Planned deletions exist only in delete mode.
    const cleanup = job.mode === "sync" && ev.status === "deleted";
    if (cleanup) {
      pushActivity(job, "info", `sync cleanup removed: ${ev.path}`);
    } else {
      pushActivity(job, what === "error" ? "error" : "file", `${what}: ${ev.path}${why}`);
      // One record per planned source file (copied, skipped, error or planned delete): the completed tally.
      const prev = job.progress || {};
      job.progress = {
        ...prev,
        done_files: (prev.done_files || 0) + 1,
        done_bytes: (prev.done_bytes || 0) + (Number(ev.bytes) || 0),
      };
    }
  } else if (ev.type === "raw") {
    pushActivity(job, "raw", ev.line);
  }
  if (job.progress && ev.type !== "progress" && ev.type !== "start") {
    const prev = job.progress;
    job.progress = {
      ...prev,
      ...(ev.copied_bytes != null ? { copied_bytes: ev.copied_bytes } : {}),
      ...(ev.verified_bytes != null ? { verified_bytes: ev.verified_bytes } : {}),
      ...(ev.destinationStates != null ? { destination_states: ev.destinationStates } : {}),
      ...(ev.destinationCount != null ? { destination_count: ev.destinationCount } : {}),
      ...(ev.slowestDestinationId !== undefined ? { slowest_destination_id: ev.slowestDestinationId } : {}),
      ...(ev.slowestDestinationRateBps !== undefined ? { slowest_destination_rate_bps: ev.slowestDestinationRateBps } : {}),
      ...(["phase", "phase_progress", "heartbeat"].includes(ev.type) ? {
        phase: ev.phase,
        phase_bytes: ev.bytesDone,
        phase_total: ev.bytesTotal,
        phase_rate_bps: ev.phaseRateBps,
        phase_elapsed_ms: ev.phaseElapsedMs,
        phase_status: ev.status,
      } : {}),
    };
  }
  if (job.progress && job.destinationResults) job.progress.destination_states = Object.values(job.destinationResults);
}

function runEngineOnce(job, srcList, destList) {
  return new Promise((resolve) => {
    const args = buildEngineArgs(job, srcList, destList);
    job.lastArgs = args.slice();

    const child = spawn(ENGINE, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.pid = child.pid;
    job.child = child;

    let stdoutBuf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        ingestStdoutLine(job, line);
      }
    });

    let stderrBuf = "";
    let stderrPending = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
      noteActivity(job);
      stderrPending += chunk;
      let idx;
      while ((idx = stderrPending.indexOf("\n")) >= 0) {
        ingestStderrLine(job, stderrPending.slice(0, idx));
        stderrPending = stderrPending.slice(idx + 1);
      }
    });

    child.on("error", (err) => {
      job.lastError = err.message;
      const ev = { type: "error", message: err.message };
      job.events.push(ev);
      appendJobLog(job.id, ev);
      resolve({ code: 1, signal: null, stderr: err.message });
    });

    child.on("close", (code, signal) => {
      if (stdoutBuf.trim()) {
        ingestStdoutLine(job, stdoutBuf.trim());
      }
      if (stderrPending.trim()) {
        ingestStderrLine(job, stderrPending);
        stderrPending = "";
      }
      job.child = null;
      if (stderrBuf.trim() && code !== 0) {
        job.lastError = job.lastError || stderrBuf.trim().slice(0, 2000);
      }
      resolve({ code, signal, stderr: stderrBuf });
    });
  });
}

function startCaffeinate(job) {
  if (!job.keepAwake) return;
  // macOS caffeinate, Linux systemd-inhibit, Windows SetThreadExecutionState. A missing tool never blocks the copy.
  job.caffeinate = platform.startKeepAwake();
  if (job.caffeinate) job.caffeinate.on("error", () => { job.caffeinate = null; });
}

function stopCaffeinate(job) {
  if (job.caffeinate && !job.caffeinate.killed) {
    try {
      job.caffeinate.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  job.caffeinate = null;
}

async function startEngineJob(job) {
  ensureDirs();
  const logPath = path.join(LOGS_DIR, `${job.id}.jsonl`);
  fs.writeFileSync(logPath, "", "utf8");
  appendJobLog(job.id, { type: "job_created", metadata: Object.fromEntries([
    "src", "dest", "mode", "verify", "perfectVerify", "hash", "include", "exclude",
    "minSize", "maxSize", "fromDate", "toDate", "speed", "diskMode", "nonstop",
    "confirm", "cascade", "writeMhl", "writeReport", "keepAwake", "resumeFrom",
    "jobName", "testDriveSpeed", "cooldownSeconds", "cooldownEveryGb", "cooldownDropPercent", "volumeBindings", "createdAt",
  ].map((key) => [key, job[key]])) });
  const reset = { type: "estimator_reset", reason: job.resumeFrom ? "resume" : "job_start", elapsedMonotonicMs: 0 };
  job.events.push(reset);
  appendJobLog(job.id, reset);
  observeEstimatorBinding(job, Date.now());
  job.driveLinks = await probeDriveLinks(job.dest || []);
  if (job.status === "cancelled") { job.finishedAt = new Date().toISOString(); writeFinishedLog(job); return; }
  for (const link of job.driveLinks) {
    if (link.warning) pushActivity(job, "error", `${link.destination}: ${link.warning}`);
  }
  if (job.testDriveSpeed) job.speedTestResults = await Promise.all((job.dest || []).map((dest) => testDriveSpeed(dest, job.id)));
  if (job.status === "cancelled") { job.finishedAt = new Date().toISOString(); writeFinishedLog(job); return; }
  job.status = "running";
  job.startedAt = new Date().toISOString();
  noteActivity(job);
  startCaffeinate(job);

  const cascade = job.cascade && job.dest?.length > 1;
  let overallOk = true;

  try {
    if (cascade) {
      const note = {
        type: "info",
        message:
          "cascade: pass1 src→dest[0]; on success pass2 same src→dest[1..] (not chaining dest[0] as source)",
      };
      job.events.push(note);
      appendJobLog(job.id, note);

      const r1 = await runEngineOnce(job, job.src, [job.dest[0]]);
      if (["paused", "stopped", "cancelled"].includes(job.status)) {
        stopCaffeinate(job); job.finishedAt = new Date().toISOString();
        job.estimate = estimateJob(job, Date.now()); writeFinishedLog(job); return;
      }
      if (r1.signal) { job.status = "incomplete"; job.error = `engine interrupted by ${r1.signal}`; job.finishedAt = new Date().toISOString(); stopCaffeinate(job); writeFinishedLog(job); return; }
      const pass1Ok = destinations.passCanContinue(job, r1);
      if (!pass1Ok) {
        overallOk = false;
        job.exitCode = r1.code;
        job.signal = r1.signal || null;
      } else {
        const r2 = await runEngineOnce(job, job.src, job.dest.slice(1));
        if (["paused", "stopped", "cancelled"].includes(job.status)) {
          stopCaffeinate(job); job.finishedAt = new Date().toISOString();
          job.estimate = estimateJob(job, Date.now()); writeFinishedLog(job); return;
        }
        if (r2.signal) { job.status = "incomplete"; job.error = `engine interrupted by ${r2.signal}`; job.finishedAt = new Date().toISOString(); stopCaffeinate(job); writeFinishedLog(job); return; }
        overallOk = destinations.passCanContinue(job, r2);
        job.exitCode = r2.code;
        job.signal = r2.signal || null;
      }
    } else {
      const r = await runEngineOnce(job, job.src, job.dest);
      // A boundary Stop can arrive while the final file is finishing. If the
      // engine has already reported done, continue through report/MHL finalisation.
      if (["paused", "stopped"].includes(job.status) && !job.engineDone) {
        stopCaffeinate(job);
        job.finishedAt = new Date().toISOString();
        job.estimate = estimateJob(job, Date.now());
        writeFinishedLog(job);
        return;
      }
      if (job.status === "cancelled") {
        stopCaffeinate(job);
        job.finishedAt = new Date().toISOString();
        job.estimate = estimateJob(job, Date.now());
        writeFinishedLog(job);
        return;
      }
      if (r.signal) {
        job.status = "incomplete";
        job.error = `engine interrupted by ${r.signal}; resume will revalidate completed files`;
        job.finishedAt = new Date().toISOString();
        stopCaffeinate(job);
        writeFinishedLog(job);
        return;
      }
      overallOk = destinations.passCanContinue(job, r);
      job.exitCode = r.code;
      job.signal = r.signal || null;
      if (!overallOk && !job.error) {
        job.error =
          job.lastError ||
          (r.stderr && String(r.stderr).trim()
            ? String(r.stderr).trim().slice(0, 2000)
            : `exit ${r.code}`);
      }
    }
  } catch (e) {
    overallOk = false;
    job.error = e.message;
  }

  stopCaffeinate(job);

  if (job.status === "cancelled") {
    job.finishedAt = new Date().toISOString();
    try {
      postProcessJob(job);
    } catch {
      /* ignore */
    }
    job.estimate = estimateJob(job, Date.now());
    writeFinishedLog(job);
    return;
  }

  destinations.settle(job);
  job.reportStatus = overallOk && (destinations.completed(job).length || !destinations.failures(job).length)
    ? destinations.failures(job).length || job.summary?.ok === false ? "done_with_errors" : "done"
    : "error";
  job.finishedAt = new Date().toISOString();
  // Finalisation (checkpoint, reports, MHL) runs while the job still reads Finishing.
  // The terminal status is set after it, so a failed required output is never a green Done.
  try {
    postProcessJob(job);
  } catch (e) {
    const text = `post-process failed: ${e.message}`;
    job.finalizeErrors.push(text);
    const ev = { type: "error", message: text };
    job.events.push(ev);
    appendJobLog(job.id, ev);
  }
  job.finishedAt = new Date().toISOString();

  if (overallOk && (destinations.completed(job).length || !destinations.failures(job).length)) {
    const engineClean =
      !(job.summary && job.summary.ok === false) && !(job.summary && job.summary.errors > 0) && !destinations.failures(job).length;
    job.status = engineClean && job.finalizeErrors.length === 0 ? "done" : "done_with_errors";
  } else if (
    (Number(job.summary?.source_errors) > 0 || Object.keys(job.summary?.failed_destinations || {}).length > 0) &&
    fs.existsSync(checkpointPath(job.id))
  ) {
    job.status = "incomplete";
    job.error ||= "A source or destination read/write failed. Reconnect or fix the affected drive and resume to revalidate completed files.";
  } else {
    job.status = "error";
    if (!job.error) {
      job.error = job.lastError || `exit ${job.exitCode}`;
    }
  }
  job.estimate = estimateJob(job, Date.now());
  writeFinishedLog(job);
}

function writeFinishedLog(job) {
  if (["cancelled", "error"].includes(job.status) && job.resumeFrom) {
    const previous = jobs.get(job.resumeFrom);
    if (previous && previous.resumedBy === job.id) {
      previous.resumedBy = null;
      const released = { type: "job_resume_released", resumedBy: job.id, timestampUtc: new Date().toISOString() };
      previous.events.push(released);
      appendJobLog(previous.id, released);
    }
  }
  appendJobLog(job.id, {
    type: "job_finished", status: job.status, finishedAt: job.finishedAt,
    summary: job.summary, reports: job.reports, error: job.error,
    finalizeErrors: job.finalizeErrors,
    destinationResults: job.destinationResults, completedDestinations: job.completedDestinations,
    driveLinks: job.driveLinks, speedSamples: job.speedSamples, speedTestResults: job.speedTestResults,
  });
}

function sanitizeJobName(name) {
  return String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function listSavedJobs() {
  ensureDirs();
  const names = fs.readdirSync(JOBS_DIR).filter((n) => n.endsWith(".json"));
  return names.map((n) => {
    const full = path.join(JOBS_DIR, n);
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      data = { error: "invalid json" };
    }
    return { name: n.replace(/\.json$/, ""), path: full, job: data };
  });
}

function listPresets() {
  ensureDirs();
  const names = fs.readdirSync(PRESETS_DIR).filter((n) => n.endsWith(".json"));
  return names.map((n) => {
    const full = path.join(PRESETS_DIR, n);
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      data = { error: "invalid json" };
    }
    return { name: n.replace(/\.json$/, ""), path: full, preset: data };
  });
}

function createJobFromFields(fields) {
  const id = makeJobId();
  const job = {
    id,
    status: "queued",
    ...fields,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    pid: null,
    child: null,
    caffeinate: null,
    events: [],
    progress: null,
    summary: null,
    error: null,
    lastError: null,
    reports: null,
    pass: 0,
    engineDone: false,
    finalizeErrors: [],
    lastActivityAt: null,
    activity: [],
    activitySeq: 0,
    diagnostics: [],
    resumedBy: null,
    resumePending: false,
    checkpointPath: checkpointPath(id),
    controlPath: controlPath(id),
    exitCode: null,
    signal: null,
    lastArgs: null,
  };
  jobs.set(id, job);
  job.completion = startEngineJob(job);
  return job;
}

async function activeJobsOnDrive(drive) {
  const active = [];
  const uncertain = [];
  for (const job of jobs.values()) {
    if (!["running", "queued", "pausing", "stopping", "planning", "finalizing"].includes(job.status)) continue;
    const paths = [...(job.src || []), ...(job.dest || [])];
    let usesDrive = false;
    for (const target of paths) {
      try {
        const mountPoint = await driveEject.mountPointForPath(target);
        if (drive.mountPoints.includes(mountPoint)) { usesDrive = true; break; }
      } catch (e) {
        uncertain.push({ job, target, error: e.message });
        break;
      }
    }
    if (usesDrive) active.push(job);
  }
  return { active, uncertain };
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === "GET" && pathname === "/api/health") {
    if (engineFlags.size === 0) probeEngineFlags();
    return json(res, 200, {
      ok: true,
      engine: ENGINE,
      engineExists: fs.existsSync(ENGINE),
      engineFlags: [...engineFlags].sort(),
      phase: "2+3",
      platform: platform.capabilities(),
    });
  }

  if (req.method === "GET" && pathname === "/api/volumes") {
    const volumes = await listVolumes();
    return json(res, 200, { volumes });
  }

  if (req.method === "GET" && pathname === "/api/drive-targets") {
    if (!platform.capabilities().eject) return json(res, 200, { drives: [], unsupported: platform.capabilities().ejectReason });
    let paths = searchParams.getAll("path").filter(Boolean);
    // No paths typed (a finished job, a refreshed page): offer every mounted drive that is not the startup disk,
    // so a card can be ejected the moment its offload is done.
    if (!paths.length) {
      const mounted = await listVolumes();
      paths = mounted.filter((v) => !v.startup).map((v) => v.mount);
    }
    const byDisk = new Map();
    for (const inputPath of paths) {
      try {
        const drive = await driveEject.inspect(inputPath);
        if (!byDisk.has(drive.wholeDisk)) byDisk.set(drive.wholeDisk, { ...drive, paths: [] });
        byDisk.get(drive.wholeDisk).paths.push(inputPath);
      } catch (e) {
        byDisk.set(`error:${inputPath}`, { path: inputPath, state: "unavailable", reason: e.message, paths: [inputPath] });
      }
    }
    return json(res, 200, { drives: [...byDisk.values()] });
  }

  if (req.method === "POST" && pathname === "/api/drives/eject") {
    if (!platform.capabilities().eject) return json(res, 501, { state: "Could not eject", error: platform.capabilities().ejectReason });
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }
    let drive;
    try { drive = await driveEject.inspect(body.path); }
    catch (e) { return json(res, 409, { state: "Could not eject", error: e.message }); }

    const { active, uncertain } = await activeJobsOnDrive(drive);
    if (uncertain.length) {
      const reason = `cannot verify drive use while active job ${uncertain[0].job.id} has an unavailable path ${uncertain[0].target}: ${uncertain[0].error}`;
      return json(res, 409, { state: "Could not eject", error: reason });
    }
    if (active.length > 1) {
      const reason = `another DitCopy job is using this drive: ${active.slice(0, 3).map((j) => `${j.id} (${j.status})`).join(", ")}`;
      active.forEach((job) => { job.ejectState = { path: drive.mountPoint, state: "Could not eject", reason }; });
      return json(res, 409, { state: "Could not eject", error: reason });
    }

    const job = active[0] || null;
    if (job) {
      job.ejectState = { path: drive.mountPoint, state: job.status === "running" ? "Stopping" : "Stopping", reason: null };
      if (job.status === "running") {
        try {
          writeControlRequest(job, "stop");
          job.status = "stopping";
          const event = { type: "job_state", state: "stopping", requestedAt: new Date().toISOString(), reason: "stop and eject" };
          job.events.push(event); appendJobLog(job.id, event);
          pushActivity(job, "info", `Stop and eject requested for ${drive.mountPoint}`);
        } catch (e) {
          const reason = `could not stop the copy safely: ${e.message}`;
          job.ejectState = { path: drive.mountPoint, state: "Could not eject", reason };
          return json(res, 500, { state: "Could not eject", error: reason });
        }
      }
      if (job.completion) await job.completion;
      if (job.child || !["stopped", "paused", "done", "done_with_errors"].includes(job.status)) {
        const reason = `copy did not reach a safe stopped state (job ${job.id}: ${job.status})`;
        job.ejectState = { path: drive.mountPoint, state: "Could not eject", reason };
        return json(res, 409, { state: "Could not eject", error: reason });
      }
    }

    try {
      if (body.resolve !== undefined && !["quit", "force"].includes(body.resolve)) {
        return json(res, 400, { state: "Could not eject", error: "resolve must be quit or force" });
      }
      const result = await driveEject.eject(body.path, { resolve: body.resolve });
      if (job) job.ejectState = { path: drive.mountPoint, state: "Safe to unplug", reason: null, finishedAt: new Date().toISOString() };
      return json(res, 200, { state: "Safe to unplug", drive: result, jobId: job?.id || null });
    } catch (e) {
      if (job) job.ejectState = { path: drive.mountPoint, state: "Could not eject", reason: e.message };
      // blockers lists the programs holding the drive, so the page can offer to quit them or to force the unmount.
      return json(res, 409, { state: "Could not eject", error: e.message, jobId: job?.id || null, blockers: e.blockers || [], forceAllowed: !!e.forceAllowed });
    }
  }

  if (req.method === "GET" && pathname === "/api/folders") {
    try {
      const params = new URL(req.url, "http://x").searchParams;
      const dir = params.get("path");
      const root = params.get("root");
      const identity = params.get("identity");
      const entries = await volumes.loadDf({ refresh: true });
      const current = await volumes.listVolumes({ appDir: ROOT, entries });
      if (!current.some((v) => v.root === root && v.identity === identity)) {
        throw new Error("Selected volume changed or is unavailable; choose it again");
      }
      return json(res, 200, volumes.listFolders(dir, root, identity, entries));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/check") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const fields = normalizeJobBody(body);
    const entries = await volumes.loadDf();
    const result = volumes.validateJob(fields, { appDir: ROOT, entries });
    const out = {
      errors: result.errors,
      warnings: result.warnings,
      src: result.src.map(({ input, resolved, exists }) => ({ input, resolved, exists })),
      dest: result.dest.map(({ input, resolved, exists }) => ({ input, resolved, exists })),
      scan: null,
      space: [],
    };
    const existing = result.src.filter((x) => x.exists).map((x) => x.resolved);
    if (existing.length) {
      out.scan = await volumes.scanSources(existing);
      // Verify only and delete write nothing, so free space is not a requirement for them.
      if (result.dest.length && fields.mode !== "verify-only" && fields.mode !== "delete") {
        out.space = volumes.spaceCheck(result.dest, out.scan, entries);
        for (const sp of out.space) {
          if (sp.short) {
            out.warnings.push(
              `Not enough space on ${sp.path}: ${volumes.human(sp.freeBytes)} free, ${volumes.human(sp.neededBytes)} planned. ${sp.explanation}`
            );
          }
        }
      }
    }
    return json(res, 200, out);
  }

  if (req.method === "GET" && pathname === "/api/presets") {
    return json(res, 200, { presets: listPresets() });
  }

  if (req.method === "GET" && pathname === "/api/saved-jobs") {
    return json(res, 200, { jobs: listSavedJobs() });
  }

  if (req.method === "POST" && pathname === "/api/saved-jobs") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const name = sanitizeJobName(body.name || body.jobName);
    if (!name) return json(res, 400, { error: "name required" });
    ensureDirs();
    const fields = normalizeJobBody(body);
    const saved = {
      name,
      ...fields,
      savedAt: new Date().toISOString(),
    };
    const filePath = path.join(JOBS_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(saved, null, 2), "utf8");
    return json(res, 201, { name, path: filePath, job: saved });
  }

  const runSaved = pathname.match(/^\/api\/saved-jobs\/([^/]+)\/run$/);
  if (req.method === "POST" && runSaved) {
    const name = sanitizeJobName(decodeURIComponent(runSaved[1]));
    const filePath = path.join(JOBS_DIR, `${name}.json`);
    if (!fs.existsSync(filePath)) return json(res, 404, { error: "saved job not found" });
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    let override = {};
    try {
      override = await readBody(req);
    } catch {
      override = {};
    }
    const merged = normalizeJobBody({ ...saved, ...override, jobName: name });
    if (DESTRUCTIVE_MODES.has(merged.mode) && !merged.confirm) {
      return json(res, 400, {
        error: `mode ${merged.mode} requires confirm: true`,
      });
    }
    if (!merged.src.length || !merged.dest.length) {
      return json(res, 400, { error: "src and dest required (non-empty arrays)" });
    }
    if (!fs.existsSync(ENGINE)) {
      return json(res, 500, { error: "engine binary missing", engine: ENGINE });
    }
    const refusal = await refuseBadJob(merged, { requireVolumeBindings: true });
    if (refusal) return json(res, 400, refusal);
    await captureJobVolumeBindings(merged);
    const job = createJobFromFields(merged);
    return json(res, 201, { id: job.id, status: job.status, from: name });
  }

  if (req.method === "GET" && pathname === "/api/history") {
    const list = [...jobs.values()]
      .filter((j) => j.finishedAt)
      .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
      .map((j) => ({
        id: j.id,
        status: j.status,
        src: j.src,
        dest: j.dest,
        mode: j.mode,
        jobName: j.jobName,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        summary: j.summary,
        reports: j.reports,
      }));
    return json(res, 200, { history: list });
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    const list = [...jobs.values()].map((j) => ({
      id: j.id,
      status: j.status,
      state: liveState(j),
      lastActivityAt: j.lastActivityAt,
      src: j.src,
      dest: j.dest,
      mode: j.mode,
      jobName: j.jobName,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      resumedBy: j.resumedBy || null,
      summary: j.summary,
      reports: j.reports,
    }));
    return json(res, 200, { jobs: list });
  }

  const reportMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/report$/);
  if (req.method === "GET" && reportMatch) {
    const job = jobs.get(reportMatch[1]);
    const id = reportMatch[1];
    const html = path.join(REPORTS_DIR, `${id}.html`);
    const txt = path.join(REPORTS_DIR, `${id}.txt`);
    const reports = job && job.reports
      ? job.reports
      : {
          html: fs.existsSync(html) ? html : null,
          txt: fs.existsSync(txt) ? txt : null,
          mhl: job && job.reports ? job.reports.mhl : [],
        };
    if (!reports.html && !reports.txt && !(reports.mhl && reports.mhl.length)) {
      if (!job) return json(res, 404, { error: "job/report not found" });
    }
    return json(res, 200, {
      id,
      reports,
      urls: {
        html: reports.html ? `/reports/${id}.html` : null,
        txt: reports.txt ? `/reports/${id}.txt` : null,
      },
    });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: "job not found" });
    return json(res, 200, jobPublic(job));
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const fields = normalizeJobBody(body);
    if (!fields.src.length || !fields.dest.length) {
      return json(res, 400, { error: "src and dest required (non-empty arrays)" });
    }
    if (!ALL_MODES.includes(fields.mode)) {
      return json(res, 400, { error: `mode must be one of ${ALL_MODES.join(", ")}` });
    }
    if (DESTRUCTIVE_MODES.has(fields.mode) && !fields.confirm) {
      return json(res, 400, {
        error: `mode ${fields.mode} requires confirm: true`,
      });
    }
    if (!fs.existsSync(ENGINE)) {
      return json(res, 500, { error: "engine binary missing", engine: ENGINE });
    }
    const refusal = await refuseBadJob(fields, { requireVolumeBindings: true });
    if (refusal) return json(res, 400, refusal);
    await captureJobVolumeBindings(fields);

    const job = createJobFromFields(fields);
    return json(res, 201, { id: job.id, status: job.status });
  }

  const controlMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|stop)$/);
  if (req.method === "POST" && controlMatch) {
    const job = jobs.get(controlMatch[1]);
    if (!job) return json(res, 404, { error: "job not found" });
    if (job.status !== "running" || !job.child) return json(res, 409, { error: "job is not running" });
    const action = controlMatch[2];
    try {
      writeControlRequest(job, action);
      job.status = action === "pause" ? "pausing" : "stopping";
      const ev = { type: "job_state", state: job.status, requestedAt: new Date().toISOString() };
      job.events.push(ev); appendJobLog(job.id, ev);
      pushActivity(job, "info", action === "pause" ? "Pause requested after current file" : "Stop requested after current file");
      return json(res, 200, { id: job.id, status: job.status });
    } catch (e) {
      return json(res, 500, { error: `could not request ${action}: ${e.message}` });
    }
  }

  const resumeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/resume$/);
  if (req.method === "POST" && resumeMatch) {
    const previous = jobs.get(resumeMatch[1]);
    if (!previous) return json(res, 404, { error: "job not found" });
    if (previous.resumedBy || previous.resumePending) {
      return json(res, 409, { error: "This job has already been resumed or a resume is already starting." });
    }
    previous.resumePending = true;
    try {
      let body = {};
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
      const retryFailed = !!body.retryFailed;
      if (retryFailed) {
        if (previous.status !== "done_with_errors" || !destinations.failures(previous).length) {
          return json(res, 409, { error: "This job has no failed destinations available to retry." });
        }
      } else if (!["paused", "stopped", "incomplete"].includes(previous.status)) {
        return json(res, 409, { error: "only paused, stopped, or incomplete jobs can be resumed" });
      }
      if (!previous.src?.length || !previous.dest?.length) {
        return json(res, 409, { error: "saved job paths are unavailable; configure the job again" });
      }
      if (!fs.existsSync(checkpointPath(previous.id))) {
        return json(res, 409, { error: "checkpoint is missing; configure a new job" });
      }

      const volumeCheck = await resumeVolumeCheck(previous);
      if (volumeCheck.error) return json(res, 409, { error: volumeCheck.error });
      if (volumeCheck.replacements.length && !body.useReplacement) {
        const choices = volumeCheck.replacements.map((item) => `${item.volumeName}: ${item.from} → ${item.to}`);
        return json(res, 409, {
          error: `A saved drive is available at a new path. Use the replacement path to resume? ${choices.join("; ")}`,
          replacements: volumeCheck.replacements,
        });
      }

      let fields = volumeCheck.replacements.length
        ? applyResumeReplacements(previous, volumeCheck.replacements)
        : normalizeJobBody({ ...previous, resumeFrom: previous.id });
      if (retryFailed) {
        const failed = new Set(destinations.failures(previous).map((state) => destinations.key(state.destinationId)));
        fields.dest = previous.dest.filter((dest) => failed.has(destinations.key(dest))).map((dest) => {
          const replacement = volumeCheck.replacements.find((item) => item.from === dest);
          return replacement ? replacement.to : dest;
        });
        fields.cascade = false;
        fields.retryFailed = true;
      }
      const refusal = await refuseBadJob(fields, { requireVolumeBindings: true });
      if (refusal) return json(res, 409, { error: refusal.error, errors: refusal.errors });
      await captureJobVolumeBindings(fields);
      const job = createJobFromFields(fields);
      markJobResumed(previous, job);
      return json(res, 201, {
        id: job.id,
        status: job.status,
        resumeFrom: previous.id,
        src: job.src,
        dest: job.dest,
        retryFailed,
        replacements: volumeCheck.replacements,
      });
    } finally {
      previous.resumePending = false;
    }
  }

  const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job) return json(res, 404, { error: "job not found" });
    if (job.child && !job.child.killed) {
      job.status = "cancelled";
      try {
        job.child.kill("SIGTERM");
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
      stopCaffeinate(job);
      const ev = { type: "error", message: "cancelled by user" };
      job.events.push(ev);
      appendJobLog(job.id, ev);
      pushActivity(job, "error", "cancelled by user");
      return json(res, 200, { id: job.id, status: "cancelled" });
    }
    return json(res, 200, { id: job.id, status: job.status, message: "not running" });
  }

  return json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const refused = checkRequest(req, PORT);
    if (refused) return json(res, 403, { error: `refused: ${refused}` });
    const u = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = u.pathname;
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, u.searchParams);
      return;
    }
    if (pathname === "/reports" || pathname.startsWith("/reports/")) {
      if (req.method === "GET" || req.method === "HEAD") {
        serveReports(req, res, pathname);
        return;
      }
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, pathname);
      return;
    }
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (e) {
    json(res, 500, { error: e.message || String(e) });
  }
});

ensureDirs();
restoreFinishedJobs(LOGS_DIR, jobs);
probeEngineFlags();
setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status === "running") {
      const reset = observeEstimatorBinding(job, now);
      if (reset) { job.events.push(reset); appendJobLog(job.id, reset); }
      job.estimate = estimateJob(job, now);
    }
  }
}, 1000).unref();
server.listen(PORT, HOST, () => {
  console.log(`DitCopy server http://${HOST}:${PORT} (phase 2+3)`);
  console.log(`engine: ${ENGINE} exists=${fs.existsSync(ENGINE)}`);
  console.log(`engine flags: ${[...engineFlags].sort().join(", ") || "(none)"}`);
});
