"use strict";
// Run: node --test ui/dest-view.test.js   (name the file; never run a directory)
const test = require("node:test");
const assert = require("node:assert");
const V = require("./dest-view");

const state = (id, extra) => ({
  destinationId: id, status: "copying", bytesWritten: 0, bytesVerified: 0,
  currentBytesWritten: 0, currentBytesVerified: 0, lastError: null, ...extra,
});
const job = (extra) => ({
  id: "j1", status: "running", dest: ["/tmp/a", "/tmp/b"], cascade: false, pass: 1, passes: 1,
  progress: { phase: "copying", total_bytes: 1000, destination_states: [] }, estimate: null, ...extra,
});

test("ETA: Learning, a range in the right unit, finishing, done", () => {
  assert.strictEqual(V.etaView(job({ estimate: { status: "learning", label: "Learning" } })).text, "Learning");
  assert.strictEqual(
    V.etaView(job({ estimate: { status: "learning", label: "Learning (rechecking_source, verifying_destination rate not measured)" } })).text,
    "Learning (source recheck, verify rate not measured)"
  );
  const range = (low, high, label) => V.etaView(job({ estimate: { status: "range", label, rangeSeconds: { low, high }, phase: "copying" } }));
  assert.strictEqual(range(5, 10, "5–10 sec").text, "5–10 sec");
  assert.strictEqual(range(120, 180, "x").text, "2–3 min");
  assert.strictEqual(range(7200, 9000, "x").text, "2–2.5 h");
  assert.strictEqual(range(5, 10, "x").note, "now: copying");
  assert.match(range(5, 10, "5–10 sec (rough measured aggregate file cycles)").text, /rough/);
  assert.strictEqual(V.etaView(job({ estimate: { status: "finishing", label: "Finishing" } })).text, "Finishing");
  assert.strictEqual(V.etaView(job({ status: "done", estimate: { status: "complete", label: "Complete" } })).text, "Done");
  assert.strictEqual(V.etaView(job({ status: "error", estimate: { status: "complete", label: "Complete" } })).text, "Stopped");
  const partial = job({
    status: "done_with_errors", estimate: { status: "complete", label: "Complete" },
    progress: { destination_states: [
      state("/tmp/a", { status: "verified" }), state("/tmp/b", { status: "failed", lastError: "mkdir denied" }),
    ] },
  });
  assert.strictEqual(V.etaView(partial).text, "Done with errors: 1 of 2 destinations complete");
  const none = job({
    status: "done_with_errors", estimate: { status: "complete", label: "Complete" },
    progress: { destination_states: [state("/tmp/a", { status: "failed" }), state("/tmp/b", { status: "failed" })] },
  });
  assert.strictEqual(V.etaView(none).text, "Done with errors: 0 of 2 destinations complete");
  assert.strictEqual(V.etaView(job({ estimate: null })).text, "—");
});

test("a range never collapses to a single time", () => {
  assert.notStrictEqual(V.fmtRange(60, 61).split("–")[0], V.fmtRange(60, 61).split("–")[1]);
  assert.strictEqual(V.fmtRange(100, 101), "2–3 min");
});

test("each destination shows its own phase from its status and the job phase", () => {
  const states = [state("/tmp/a", { status: "copying" }), state("/tmp/b", { status: "verifying" })];
  const j = job({ progress: { phase: "verifying_destination", total_bytes: 1000, destination_states: states } });
  const { rows } = V.buildRows(j, null, 1000);
  assert.deepStrictEqual(rows.map((r) => r.label), ["Verifying", "Verifying"]);
  const recheck = job({ progress: { phase: "rechecking_source", total_bytes: 1000, destination_states: [state("/tmp/a"), state("/tmp/b", { status: "copied" })] } });
  assert.deepStrictEqual(V.buildRows(recheck, null, 0).rows.map((r) => r.label), ["Source recheck", "Source recheck"]);
  const mixed = job({ progress: { phase: "copying", total_bytes: 1000, destination_states: [state("/tmp/a"), state("/tmp/b", { status: "verified" })] } });
  assert.deepStrictEqual(V.buildRows(mixed, null, 0).rows.map((r) => r.label), ["Copying", "Verified"]);
});

test("finishing and done override a healthy destination, never a failed one", () => {
  const states = [state("/tmp/a", { status: "verified" }), state("/tmp/b", { status: "failed", lastError: "create b.bin: permission denied" })];
  const finishing = job({ estimate: { status: "finishing" }, progress: { phase: "finalising", total_bytes: 1000, destination_states: states } });
  const rows = V.buildRows(finishing, null, 0).rows;
  assert.deepStrictEqual(rows.map((r) => r.label), ["Finishing", "Failed"]);
  assert.strictEqual(rows[1].error, "create b.bin: permission denied");
  assert.strictEqual(rows[1].tone, "bad");
  const done = job({ status: "done_with_errors", progress: { phase: "finalising", total_bytes: 1000, destination_states: states } });
  assert.deepStrictEqual(V.buildRows(done, null, 0).rows.map((r) => r.label), ["Done", "Failed"]);
  assert.strictEqual(V.buildRows(job({ status: "cancelled", progress: { total_bytes: 1000, destination_states: [state("/tmp/a")] } }), null, 0).rows[0].label, "Cancelled");
});

test("cascade: the second destination waits for pass 2; the first keeps its figures once its pass is over", () => {
  const pass1 = job({ cascade: true, pass: 1, passes: 1, progress: { phase: "copying", total_bytes: 1000, destination_states: [state("/tmp/a", { bytesWritten: 400 })] } });
  const memory = { seen: {}, samples: {} };
  let rows = V.buildRows(pass1, memory, 0).rows;
  assert.deepStrictEqual(rows.map((r) => r.label), ["Copying", "Waiting for pass 2"]);
  const pass2 = job({ cascade: true, pass: 2, passes: 2, progress: { phase: "copying", total_bytes: 1000, destination_states: [state("/tmp/b", { bytesWritten: 100 })] } });
  rows = V.buildRows(pass2, memory, 1000).rows;
  assert.deepStrictEqual(rows.map((r) => r.label), ["Done", "Copying"]);
  assert.strictEqual(rows[0].written, 400, "pass 1 figures are kept");
});

test("destination ids match through /private and trailing slashes", () => {
  assert.ok(V.sameDest("/tmp/a", "/private/tmp/a/"));
  assert.ok(!V.sameDest("/tmp/a", "/tmp/ab"));
  const rows = V.buildRows(job({ progress: { phase: "copying", total_bytes: 1000, destination_states: [state("/private/tmp/a", { bytesWritten: 7 })] } }), null, 0).rows;
  assert.strictEqual(rows[0].written, 7);
  assert.strictEqual(rows[1].label, "Waiting");
});

test("speed is measured between polls, unknown until bytes move, and stale after 3 s", () => {
  const memory = { seen: {}, samples: {} };
  const at = (written, nowMs) => V.buildRows(job({ progress: { phase: "copying", total_bytes: 10e6, destination_states: [state("/tmp/a", { bytesWritten: written })] } }), memory, nowMs).rows[0].speedBps;
  assert.strictEqual(at(0, 0), null);
  assert.strictEqual(at(0, 400), null);
  assert.strictEqual(Math.round(at(1e6, 1000)), 1e6);
  assert.strictEqual(at(1e6, 2000) > 0, true, "rate kept while the last movement is recent");
  assert.strictEqual(at(1e6, 4500), null, "stale after 3 s without movement");
});

test("a job with no destinations known yet draws nothing and does not throw", () => {
  assert.deepStrictEqual(V.buildRows({ id: "x", status: "queued", progress: null }, null, 0).rows, []);
});

test("stopped and finished job states take precedence over stale resume validation", () => {
  for (const status of ["paused", "stopped", "done", "incomplete", "error"]) {
    assert.strictEqual(V.jobStateText({status, state: status, progress: {phase: "resume_validation"}}), status);
  }
  assert.strictEqual(V.jobStateText({status: "running", progress: {phase: "resume_validation"}}), "Checking already copied files");
});

test("a verify only job says Verifying, a copy job still says Copying", () => {
  assert.strictEqual(V.jobStateText({ status: "running", mode: "verify-only", state: "Copying", progress: {} }), "Verifying");
  assert.strictEqual(V.jobStateText({ status: "running", mode: "force", state: "Copying", progress: {} }), "Copying");
  assert.strictEqual(V.jobStateText({ status: "done", mode: "verify-only", state: "Done", progress: {} }), "Done");
});
