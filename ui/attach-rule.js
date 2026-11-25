"use strict";
// Which job the page should show and poll. Pure, so the rule that stopped the panels from
// blinking (never re-attach to a job that is already on screen and not running) is tested.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DitAttach = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LIVE = ["running", "queued", "pausing", "stopping"];
  const newestFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

  /** Returns { job, live, otherRunning } to attach to, or null to leave the screen alone. */
  function pickAttach(list, activeJobId) {
    const live = list.filter((j) => LIVE.includes(j.status)).sort(newestFirst);
    // The newest job is the one the user just worked with. An older incomplete job must not take its place after a refresh.
    const job = live[0] || list.filter((j) => !j.resumedBy).sort(newestFirst)[0];
    if (!job) return null;
    if (!live[0] && activeJobId === job.id) return null;
    return { job, live: !!live[0], otherRunning: live.length - (live[0] ? 1 : 0) };
  }
  return { pickAttach };
});
