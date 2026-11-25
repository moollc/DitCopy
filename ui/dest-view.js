"use strict";
// Per-destination rows and the job ETA for the Progress panel. Pure functions, no page
// access, so the same file runs in the browser and under node for the unit tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DitDest = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PHASE_NAMES = {
    copying: "copying",
    reading_source: "source read",
    rechecking_source: "source recheck",
    resume_validation: "Checking already copied files",
    verifying_destination: "verify",
  };
  const ENDED = ["done", "done_with_errors", "error", "cancelled"];
  // After this long without new bytes a destination's speed is shown as unknown, not as a stale figure.
  const SPEED_STALE_MS = 3000;

  /** Phase keys inside an estimator label read as plain words. */
  function friendly(label) {
    return String(label || "").replace(
      /resume_validation|reading_source|rechecking_source|verifying_destination|copying/g,
      (key) => PHASE_NAMES[key]
    );
  }

  /** A range of seconds as seconds, minutes or hours, never a single promised time. */
  function fmtRange(low, high) {
    if (high < 90) return `${low}–${high} sec`;
    if (high < 5400) {
      const a = Math.round(low / 60);
      const b = Math.max(a + 1, Math.round(high / 60));
      return `${a}–${b} min`;
    }
    const a = Math.round((low / 3600) * 10) / 10;
    const b = Math.max(a + 0.1, Math.round((high / 3600) * 10) / 10);
    return `${a}–${b} h`;
  }

  /** The job ETA as shown: a range, Learning, or the plain state. Never a precise time. */
  function etaView(job) {
    const est = job && job.estimate;
    if (!est) return { text: "—", note: "" };
    const note = est.phase && PHASE_NAMES[est.phase] ? `now: ${PHASE_NAMES[est.phase]}` : "";
    switch (est.status) {
      case "range": {
        const r = est.rangeSeconds;
        const rough = /rough/.test(est.label || "") ? " (rough, from file cycles)" : "";
        return { text: r ? fmtRange(r.low, r.high) + rough : friendly(est.label), note };
      }
      case "learning":
      case "waiting":
        return { text: friendly(est.label), note: est.status === "learning" ? note : "" };
      case "finishing":
        return { text: "Finishing", note: "" };
      case "complete":
        return { text: completeText(job), note: "" };
      default:
        return { text: friendly(est.label) || "—", note: "" };
    }
  }

  /** Destinations of the job that finished with a good copy (verified or copied). */
  function completeCount(job) {
    const states = (job.progress && job.progress.destination_states) || [];
    const dests = Array.isArray(job.dest) && job.dest.length ? job.dest : states.map((s) => s.destinationId);
    return dests.filter((d) => states.some((s) => sameDest(s.destinationId, d) && ["verified", "copied"].includes(s.status))).length;
  }

  /** The plain end state of a job whose estimate is complete. */
  function completeText(job) {
    if (job.status === "done") return "Done";
    if (job.status === "cancelled") return "Cancelled";
    if (job.status === "done_with_errors") {
      const total = Array.isArray(job.dest) ? job.dest.length : 0;
      return `Done with errors: ${completeCount(job)} of ${total} destinations complete`;
    }
    return "Stopped";
  }

  function norm(p) {
    return String(p || "").replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
  }

  function sameDest(a, b) {
    return norm(a) === norm(b);
  }

  /** [label, tone] for one live destination state. */
  function stateLabel(state, jobPhase, ended, finishing, jobStatus) {
    if (state.status === "failed") return ["Failed", "bad"];
    if (jobStatus === "cancelled") return ["Cancelled", "bad"];
    if (ended) {
      return state.status === "verified" || state.status === "copied"
        ? ["Done", "good"]
        : ["Stopped", "bad"];
    }
    if (finishing) return ["Finishing", "live"];
    switch (state.status) {
      case "verified":
        return ["Verified", "good"];
      case "verifying":
        return ["Verifying", "live"];
      case "copied":
        if (jobPhase === "resume_validation") return ["Checking already copied files", "live"];
        if (jobPhase === "rechecking_source") return ["Source recheck", "live"];
        if (jobPhase === "verifying_destination") return ["Verifying", "live"];
        return ["Copied", "good"];
      case "copying":
        if (jobPhase === "resume_validation") return ["Checking already copied files", "live"];
        if (jobPhase === "reading_source") return ["Reading source", "live"];
        if (jobPhase === "rechecking_source") return ["Source recheck", "live"];
        if (jobPhase === "verifying_destination") return ["Verifying", "live"];
        return ["Copying", "live"];
      default:
        return ["Waiting", "wait"];
    }
  }

  /**
   * One row per destination of the job. `memory` carries what earlier polls saw
   * ({seen, samples}); a cascade destination whose pass is over keeps its last figures.
   * Speed is measured from bytes between polls; it is null until two readings differ.
   */
  function buildRows(job, memory, nowMs) {
    const mem = memory || { seen: {}, samples: {} };
    const p = (job && job.progress) || {};
    const states = Array.isArray(p.destination_states) ? p.destination_states : [];
    const dests = Array.isArray(job.dest) && job.dest.length ? job.dest : states.map((s) => s.destinationId);
    const ended = ENDED.includes(job.status);
    const finishing = !!(job.estimate && job.estimate.status === "finishing");
    const cascade = !!job.cascade && dests.length > 1;
    const rows = dests.map((dest, index) => {
      const key = norm(dest);
      const live = states.find((s) => sameDest(s.destinationId, dest)) || null;
      if (live) mem.seen[key] = live;
      const state = live || mem.seen[key] || null;
      const passOf = cascade ? (index === 0 ? 1 : 2) : 1;
      let label;
      let tone;
      if (!state) {
        const waitingForPass = cascade && (job.pass || 1) < passOf;
        [label, tone] = ended
          ? ["Not started", "bad"]
          : [waitingForPass ? `Waiting for pass ${passOf}` : "Waiting", "wait"];
      } else if (!live && cascade && (job.pass || 1) > passOf && state.status !== "failed") {
        [label, tone] = ["Done", "good"];
      } else {
        [label, tone] = stateLabel(state, p.phase, ended, finishing, job.status);
      }
      const written = state ? state.bytesWritten || 0 : 0;
      const verified = state ? state.bytesVerified || 0 : 0;
      let speedBps = null;
      if (live && !ended && tone === "live") {
        const worked = written + verified;
        const prev = mem.samples[key];
        if (!prev) {
          mem.samples[key] = { bytes: worked, at: nowMs, rate: null, moved: nowMs };
        } else if (worked > prev.bytes && nowMs > prev.at) {
          const inst = ((worked - prev.bytes) / (nowMs - prev.at)) * 1000;
          prev.rate = prev.rate == null ? inst : 0.5 * prev.rate + 0.5 * inst;
          prev.bytes = worked;
          prev.at = nowMs;
          prev.moved = nowMs;
        }
        const sample = mem.samples[key];
        if (sample.rate != null && nowMs - sample.moved < SPEED_STALE_MS) speedBps = sample.rate;
      }
      return {
        key,
        name: dest,
        label,
        tone,
        written,
        verified,
        total: p.total_bytes == null ? null : p.total_bytes,
        speedBps,
        error: state && state.lastError ? String(state.lastError) : "",
        known: !!state,
        // A destination whose cascade pass is over was last seen mid pass, so its verified figure is not trusted.
        verifiedKnown: !(!live && state),
      };
    });
    return { rows, memory: mem };
  }

  function jobStateText(job) {
    const live = ["running", "queued"].includes(job.status);
    if (live && job.progress?.phase === "resume_validation") return "Checking already copied files";
    // A verify only job copies nothing, so it must not say Copying.
    if (live && job.mode === "verify-only" && (job.state || "Copying") === "Copying") return "Verifying";
    return job.state || job.status;
  }
  return { etaView, buildRows, fmtRange, friendly, sameDest, stateLabel, jobStateText };
});
