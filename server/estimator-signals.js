"use strict";
const fs = require("fs");
const path = require("path");
const SETTINGS = ["src", "dest", "mode", "verify", "perfectVerify", "hash", "include", "exclude",
  "minSize", "maxSize", "fromDate", "toDate", "speed", "diskMode", "cascade"];
function deviceOf(input, stat) {
  let current = path.resolve(input);
  for (;;) {
    try { return String(stat(current).dev); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return "unavailable";
      current = parent;
    }
  }
}
/** Called by the real server tick, never from message text or a synthetic event name. */
function observeEstimatorBinding(job, nowMs = Date.now(), stat = fs.statSync) {
  const configuration = JSON.stringify(SETTINGS.map(key => job[key] ?? null));
  const devices = JSON.stringify([...(job.src || []), ...(job.dest || [])].map(p => deviceOf(p, stat)));
  const before = job.estimatorBinding;
  job.estimatorBinding = { configuration, devices };
  if (!before || (before.configuration === configuration && before.devices === devices)) return null;
  const lastStart = job.events.findLastIndex(e => e.type === "start");
  const elapsed = job.events.slice(Math.max(0, lastStart)).reduce((t,e) => Math.max(t, Number(e.elapsedMonotonicMs) || 0),0);
  return {type:"estimator_reset",reason:before.devices !== devices ? "device_changed" : "configuration_changed",
    elapsedMonotonicMs:elapsed + 1, observedAt:nowMs};
}
module.exports = {observeEstimatorBinding};
