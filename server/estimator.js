"use strict";

const PHASES = ["copying", "reading_source", "rechecking_source", "verifying_destination"];
const MIB = 1024 * 1024;
const zero = () => Object.fromEntries(PHASES.map(p => [p, 0]));
const number = v => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0;
function roundSeconds(value) {
  const step = value < 60 ? 5 : value < 600 ? 30 : 60;
  return Math.max(step, Math.round(value / step) * step);
}
function plan(ev) {
  const work = { copying: number(ev.work_copy_bytes), reading_source: number(ev.work_read_bytes),
    rechecking_source: number(ev.work_recheck_bytes), verifying_destination: number(ev.work_verify_bytes) };
  if (!Object.values(work).some(Boolean)) work.copying = number(ev.work_bytes ?? ev.bytes);
  return work;
}
const matchesFile = (absolute, relative) => absolute === relative || (typeof absolute === "string" && absolute.endsWith("/" + relative));

/** Pure replay. Each engine pass has its own monotonic clock and counters. */
function estimate(job, nowMs = Date.now()) {
  const events = Array.isArray(job.events) ? job.events.filter(e => e && typeof e === "object") : [];
  const passes = [];
  let pass = null;
  for (const ev of events) {
    if (ev.type === "start") {
      pass = { events: [], plan: plan(ev), start: ev, done: false };
      passes.push(pass);
    }
    if (pass) { pass.events.push(ev); if (ev.type === "done") pass.done = true; }
  }
  const work = zero(), done = zero(), rates = {}, rateSource = {};
  let elapsedMs = 0, phase = null, waiting = false, aggregateRate = 0, uncertainty = null;
  for (const p of passes) {
    const counts = zero(), phaseCompleted = zero(), active = zero(), authoritative = zero();
    const successful = p.events.filter(e => e.type === "file" && ["copied", "verified"].includes(e.status));
    const skipped = p.events.filter(e => e.type === "file" && e.status === "skipped").map(e => e.path);
    const payload = successful.reduce((sum, e) => sum + number(e.bytes), 0);
    const eligiblePayload = number(p.start.work_bytes) > 0 && number(p.start.work_copy_bytes) === 0
      ? number(p.start.work_recheck_bytes) : number(p.start.work_copy_bytes || p.start.work_bytes || p.start.bytes);
    let lastMovement = 0, windowStart = 0, wasWaiting = false;
    const signatures = new Map(), samples = new Map(), detailedAt = new Map();
    for (const key of Object.keys(rates)) { delete rates[key]; delete rateSource[key]; }
    let sawDetailedWork = false, lastAggregate = 0;
    const localRates = {}, monitors = new Map();
    let uncertainUntil = 0, uncertainReason = null;
    function observeRate(name, rate, t) {
      if (!(rate > 0)) return;
      let monitor = monitors.get(name);
      if (!monitor) { monitors.set(name, {reference:rate, departedAt:null}); return; }
      if (Math.abs(rate / monitor.reference - 1) > 0.4) {
        if (monitor.departedAt == null) monitor.departedAt = t;
        if (t - monitor.departedAt >= 10000) {
          uncertainUntil = t + 10000;
          uncertainReason = "sustained performance change";
          localRates[name] = rate;
          monitor = {reference:rate, departedAt:null};
          monitors.set(name, monitor);
        }
      } else monitor.departedAt = null;
    }
    for (const ev of p.events) {
      const t = number(ev.elapsedMonotonicMs);
      if (ev.type === "estimator_reset") {
        windowStart = t; lastMovement = t; signatures.clear(); samples.clear(); monitors.clear();
        if (["device_changed", "configuration_changed"].includes(ev.reason)) {
          uncertainUntil = t + 15000;
          uncertainReason = ev.reason === "device_changed" ? "device change" : "configuration change";
        }
        for (const key of Object.keys(localRates)) delete localRates[key];
      }
      const excluded = skipped.some(rel => matchesFile(ev.fileId, rel));
      const recheckKnown = ev.phase !== "rechecking_source" || !ev.fileId || successful.some(f => matchesFile(ev.fileId, f.path));
      if (["phase", "phase_progress"].includes(ev.type) && PHASES.includes(ev.phase) && !excluded && recheckKnown) {
        sawDetailedWork = true;
        if (ev.type === "phase" && ev.status === "completed") {
          phaseCompleted[ev.phase] += number(ev.bytesDone); active[ev.phase] = 0;
        } else if (ev.status !== "failed") active[ev.phase] = number(ev.bytesDone);
        if (ev.status === "failed") active[ev.phase] = 0;
        const sampleKey = `${ev.phase}|${ev.fileId || ""}|${ev.destinationId || ""}`;
        const previous = samples.get(sampleKey);
        const sampleRate = previous && previous.t >= windowStart && t > previous.t && number(ev.bytesDone) > previous.bytes
          ? (number(ev.bytesDone)-previous.bytes)*1000/(t-previous.t)
          : windowStart === 0 ? number(ev.phaseRateBps) : 0;
        if (sampleRate > 0) localRates[ev.phase] = localRates[ev.phase] == null
          ? sampleRate : localRates[ev.phase] * 0.7 + sampleRate * 0.3;
        observeRate(ev.phase, sampleRate, t);
        if (sampleRate > 0) detailedAt.set(ev.phase, t);
        samples.set(sampleKey, {t, bytes:number(ev.bytesDone)});
        phase = ev.phase;
      }
      if (ev.workDoneByPhase) {
        for (const key of PHASES) authoritative[key] = number(ev.workDoneByPhase[key]);
      }
      if (ev.workRatesBps && !wasWaiting && windowStart === 0) {
        for (const key of PHASES) if (number(ev.workRatesBps[key]) > 0 && t - (detailedAt.get(key) ?? -Infinity) > 1000) {
          localRates[key] = number(ev.workRatesBps[key]);
          observeRate(key, localRates[key], t);
        }
      }
      if (ev.copied_bytes != null) counts.copying = Math.max(counts.copying, number(ev.copied_bytes));
      if (ev.verified_bytes != null) counts.verifying_destination = Math.max(counts.verifying_destination, number(ev.verified_bytes));
      if (ev.type === "done" && p.start.mode !== "verify-only") counts.copying = Math.max(counts.copying, number(ev.bytes));
      if (ev.type === "progress" && number(ev.speed_bps)) lastAggregate = number(ev.speed_bps);
      const signature = JSON.stringify([ev.workDoneByPhase || null, ev.copied_bytes ?? null, ev.verified_bytes ?? null,
        PHASES.includes(ev.phase) ? ev.bytesDone : null, ev.type === "file" ? ev.path : null]);
      // A heartbeat is a real engine signal; never treat its tiny/stale rate as a sample.
      if (ev.type === "heartbeat") {
        if (t - lastMovement >= 5000) wasWaiting = true;
      } else if (["progress", "phase_progress", "file", "phase"].includes(ev.type)) {
        const channel = `${ev.type}|${ev.phase || ""}|${ev.fileId || ""}|${ev.destinationId || ""}`;
        const moved = ev.type === "file" || (ev.type === "phase" && ev.status === "completed") ||
          (signature !== signatures.get(channel) && (number(ev.bytesDone) > 0 || number(ev.copied_bytes) > 0 || number(ev.verified_bytes) > 0));
        if (moved) {
          if (wasWaiting) {
            windowStart = t;
            for (const key of Object.keys(localRates)) delete localRates[key];
          }
          wasWaiting = false; lastMovement = t;
        }
        signatures.set(channel, signature);
      }
      if (ev.type === "heartbeat" && PHASES.includes(ev.phase)) phase = ev.phase;
    }
    const t = p.events.reduce((max,e) => Math.max(max,number(e.elapsedMonotonicMs)),0);
    elapsedMs = t - windowStart;
    uncertainty = t <= uncertainUntil && uncertainReason ? uncertainReason : null;
    waiting = wasWaiting && !p.done;
    // Whole-file outcomes supply suppressed small-file work. A skipped/error
    // outcome supplies nothing. Compare alternate observations, never add them.
    counts.copying = Math.max(counts.copying, p.start.mode === "verify-only" ? 0 : payload);
    const completedPayload = p.done ? Math.max(payload, ...p.events.filter(e=>e.type==="done").map(e=>number(e.bytes))) : payload;
    if (p.plan.rechecking_source > 0) counts.rechecking_source = completedPayload;
    if (p.plan.reading_source > 0) counts.reading_source = completedPayload;
    for (const key of PHASES) {
      work[key] += p.plan[key];
      done[key] += Math.min(p.plan[key], Math.max(counts[key], phaseCompleted[key] + active[key], authoritative[key]));
    }
    Object.assign(rates, localRates);
    for (const key of Object.keys(localRates)) rateSource[key] = "measured";
    // Old streams suppressed individual phases. Repeated successfully completed
    // file cycles measure the complete mix, not a guessed verify/copy ratio.
    if (!sawDetailedWork && successful.length >= 2 && lastAggregate > 0 && eligiblePayload > 0 && payload > 0 && !waiting) {
      aggregateRate = lastAggregate * Object.values(p.plan).reduce((a,b) => a+b,0) / eligiblePayload;
    } else aggregateRate = 0;
  }
  if (job.cascade && Array.isArray(job.dest) && job.dest.length > 1 && passes.length === 1) {
    const first = passes[0].plan, additionalDestinations = job.dest.length - 1;
    for (const key of PHASES) {
      const multiplier = key === "verifying_destination" || (key === "copying" && job.diskMode === "same") ? additionalDestinations : 1;
      work[key] += first[key] * multiplier;
    }
  }
  const remainingByPhase = Object.fromEntries(PHASES.map(key => [key, Math.max(0, work[key] - done[key])]));
  const remainingBytes = Object.values(remainingByPhase).reduce((a,b)=>a+b,0);
  const observed = Object.values(done).reduce((a,b)=>a+b,0);
  const morePasses = job.cascade && job.dest?.length > 1 && passes.length < 2;
  const base = {remainingBytes, remainingByPhase, phaseRatesBps: rates, phaseRateSource: rateSource, rangeSeconds:null, phase, ...(uncertainty ? {relearningReason:uncertainty} : {})};
  if (["done","done_with_errors","error","cancelled"].includes(job.status)) return {...base,status:"complete",label:"Complete",remainingBytes:0};
  if (!morePasses && job.engineDone) return {...base,status:"finishing",label:"Finishing reports…",remainingBytes:0,phase:"finalising"};
  if (waiting) return {...base,status:"waiting",label:"Waiting for device progress; estimate suspended",rangeSeconds:null};
  const allMeasured = PHASES.every(key => remainingByPhase[key] === 0 || number(rates[key]) > 0);
  if (elapsedMs < 5000 || observed < 64*MIB || (!allMeasured && !aggregateRate)) {
    const missing = PHASES.filter(key => remainingByPhase[key] > 0 && !rates[key]);
    return {...base,status:"learning",label:missing.length ? `Learning (${missing.join(", ")} rate not measured)` : "Learning"};
  }
  // No cross-phase inference and no throttle multiplier. Until measured, there
  // is no promised range. Aggregate cycles are explicitly named in the label.
  const midpoint = aggregateRate && !allMeasured ? remainingBytes/aggregateRate
    : PHASES.reduce((sum,key)=>sum+(remainingByPhase[key] ? remainingByPhase[key]/rates[key] : 0),0);
  const low = roundSeconds(midpoint*(uncertainty ? 0.5 : 0.8));
  const high = Math.max(roundSeconds(midpoint*(uncertainty ? 2 : 1.2)),low+(midpoint<60?5:midpoint<600?30:60));
  return {...base,status:"range",label:`${low}–${high} sec${uncertainty ? ` (relearning after ${uncertainty})` : !allMeasured ? " (rough measured aggregate file cycles)" : ""}`,
    rangeSeconds:{low,high}, ...(aggregateRate && !allMeasured ? {aggregateRateBps:aggregateRate,aggregateRateSource:"measured_file_cycles"} : {})};
}

function safeEstimate(job, nowMs = Date.now(), logger = console.warn) {
  try { return estimate(job, nowMs); }
  catch (error) {
    if (!job.estimateErrorLogged) {
      job.estimateErrorLogged = true;
      logger(`estimate unavailable for ${job.id || "job"}: ${error.message}`);
    }
    return null;
  }
}
module.exports = {estimate, safeEstimate, roundSeconds};
