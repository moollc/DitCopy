"use strict";
const fs = require("fs");
const path = require("path");
const {recordDestinations} = require("./destination-outcomes");

function restoreFinishedJobs(LOGS_DIR, jobs, warn = console.warn) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  for (const name of fs.readdirSync(LOGS_DIR).filter((n) => n.endsWith(".jsonl")).sort()) {
    const id = name.slice(0, -6);
    const file = path.join(LOGS_DIR, name);
    const restored = {
      id, status: "running", src: null, dest: null, mode: null, verify: null,
      perfectVerify: null, hash: null, include: null, exclude: null, minSize: null,
      maxSize: null, fromDate: null, toDate: null, speed: null, diskMode: null,
      nonstop: null, confirm: null, cascade: null, writeMhl: null, writeReport: null,
      keepAwake: null, resumeFrom: null, jobName: null, createdAt: null, startedAt: null,
      volumeBindings: [], resumedBy: null,
      finishedAt: null, events: [], progress: null, summary: null, reports: null,
      error: null, lastError: null, pass: 0, engineDone: false, finalizeErrors: [],
      lastActivityAt: null, activity: [], activitySeq: 0, diagnostics: [], estimate: null,
    };
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let terminal = false;
    let serverFinished = false;
    let hasCreatedMetadata = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      let ev;
      try { ev = JSON.parse(lines[i]); }
      catch (e) {
        warn(`history: skipped malformed ${name}:${i + 1}: ${e.message}`);
        continue;
      }
      if (ev.type === "job_created") {
        hasCreatedMetadata = true;
        Object.assign(restored, ev.metadata || {});
        continue;
      }
      if (ev.type === "job_resumed") {
        restored.resumedBy = ev.resumedBy || restored.resumedBy;
        restored.events.push(ev);
        continue;
      }
      if (ev.type === "job_resume_released") {
        if (restored.resumedBy === ev.resumedBy) restored.resumedBy = null;
        restored.events.push(ev);
        continue;
      }
      if (ev.type === "job_finished") {
        restored.status = ev.status || "done_with_errors";
        restored.finishedAt = ev.finishedAt || ev.at || new Date().toISOString();
        restored.summary = ev.summary || restored.summary;
        restored.reports = ev.reports || null;
        restored.error = ev.error || null;
        restored.finalizeErrors = ev.finalizeErrors || [];
        if (["paused", "stopped", "incomplete"].includes(restored.status)) restored.error = null;
        restored.destinationResults = ev.destinationResults || restored.destinationResults;
        restored.completedDestinations = ev.completedDestinations || restored.completedDestinations;
        restored.driveLinks = ev.driveLinks || restored.driveLinks || [];
        restored.speedSamples = ev.speedSamples || restored.speedSamples || [];
        restored.speedTestResults = ev.speedTestResults || restored.speedTestResults || [];
        terminal = true;
        serverFinished = true;
        continue;
      }
      restored.events.push(ev);
      recordDestinations(restored, ev);
      if (!restored.createdAt && ev.timestampUtc) restored.createdAt = ev.timestampUtc;
      if (ev.type === "start") {
        restored.pass++; restored.startedAt ||= ev.timestampUtc || null;
        // Only fields actually present in a legacy start are known.
        if (ev.mode != null && restored.mode == null) restored.mode = ev.mode;
        if (ev.hash_algo != null && restored.hash == null) restored.hash = ev.hash_algo;
      }
      if (ev.type === "progress" || ev.type === "phase" || ev.type === "phase_progress" || ev.type === "heartbeat") {
        restored.progress = {
          ...(restored.progress || {}),
          ...(ev.copied_files != null ? { copied_files: ev.copied_files } : {}),
          ...(ev.copied_bytes != null ? { copied_bytes: ev.copied_bytes } : {}),
          ...(ev.verified_bytes != null ? { verified_bytes: ev.verified_bytes } : {}),
          ...(ev.current != null ? { current: ev.current } : {}),
          ...(ev.speed_bps != null ? { speed_bps: ev.speed_bps } : {}),
          ...(ev.destinationStates != null ? { destination_states: ev.destinationStates } : {}),
          ...(ev.phase !== undefined ? { phase: ev.phase, phase_bytes: ev.bytesDone, phase_total: ev.bytesTotal, phase_rate_bps: ev.phaseRateBps } : {}),
        };
      }
      if (ev.type === "done") { restored.summary = ev; restored.engineDone = true; terminal = true; }
      if (ev.type === "error") restored.lastError = ev.message || ev.error || null;
    }
    if (terminal || hasCreatedMetadata) {
      if (!restored.finishedAt) restored.finishedAt = restored.events.at(-1)?.timestampUtc || new Date(fs.statSync(file).mtimeMs).toISOString();
      if (!serverFinished) {
        // An engine pass is not server finalization; a log with no terminal marker is resumable incomplete work.
        restored.status = "incomplete";
        restored.error = "Incomplete history: no server job_finished record";
      }
      if (!restored.createdAt) restored.createdAt = restored.startedAt || restored.finishedAt;
      if (restored.progress) restored.progress.destination_states = Object.values(restored.destinationResults || {});
      jobs.set(id, restored);
    }
  }
}

module.exports = { restoreFinishedJobs };
