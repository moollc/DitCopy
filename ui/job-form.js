"use strict";
// Rebuilds the form fields from a running job, so a refresh, a second window or the native app opened
// mid-copy shows what is being copied instead of an empty form. Pure, so it runs under node for tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DitJobForm = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LIVE = ["running", "queued", "pausing", "stopping"];

  /** Preset-shaped object for applyPreset, or null when the job is not live or has no paths. Never carries confirm. */
  function jobToPreset(job) {
    if (!job || !LIVE.includes(job.status)) return null;
    if (!Array.isArray(job.src) || !job.src.length || !Array.isArray(job.dest) || !job.dest.length) return null;
    const keys = ["mode", "hash", "speed", "verify", "perfectVerify", "nonstop", "cascade", "writeMhl",
      "writeReport", "keepAwake", "skipSystemFiles", "include", "exclude", "minSize", "maxSize", "fromDate", "toDate",
      "testDriveSpeed", "cooldownSeconds", "cooldownEveryGb", "cooldownDropPercent"];
    const p = { src: job.src.slice(), dest: job.dest.slice(), name: job.jobName || "" };
    for (const k of keys) if (job[k] !== undefined) p[k] = job[k];
    return p;
  }

  /** Fill only an empty form: never overwrite paths the user typed or a job this page started. */
  function formIsEmpty(srcText, destText) {
    return !String(srcText || "").trim() && !String(destText || "").trim();
  }

  return { jobToPreset, formIsEmpty };
});
