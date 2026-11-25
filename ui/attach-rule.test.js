"use strict";
// Run: node --test ui/attach-rule.test.js
const test = require("node:test");
const assert = require("node:assert");
const { pickAttach } = require("./attach-rule");

const j = (id, status, createdAt, extra) => ({ id, status, createdAt, ...extra });

test("a running job wins over older recoverable ones", () => {
  const r = pickAttach([j("old", "incomplete", "2026-01-01"), j("now", "running", "2026-02-01")], null);
  assert.strictEqual(r.job.id, "now");
  assert.strictEqual(r.live, true);
});
test("a stopped job already on screen is not attached again (the blink)", () => {
  const list = [j("old", "incomplete", "2026-01-01")];
  assert.strictEqual(pickAttach(list, "old"), null);
  assert.strictEqual(pickAttach(list, null).job.id, "old");
});
test("a running job already on screen is still returned so polling can continue", () => {
  assert.strictEqual(pickAttach([j("a", "running", "2026-02-01")], "a").job.id, "a");
});
test("counts other running jobs", () => {
  const r = pickAttach([j("a", "running", "2026-02-01"), j("b", "running", "2026-03-01")], null);
  assert.strictEqual(r.job.id, "b");
  assert.strictEqual(r.otherRunning, 1);
});
test("resumed jobs are skipped and an empty list gives null", () => {
  assert.strictEqual(pickAttach([j("a", "incomplete", "2026-01-01", { resumedBy: "b" })], null), null);
  assert.strictEqual(pickAttach([], null), null);
});

test("the newest job wins over an older incomplete one after a refresh", () => {
  const list = [j("old", "incomplete", "2026-01-01"), j("fresh", "done", "2026-03-01")];
  assert.strictEqual(pickAttach(list, null).job.id, "fresh");
});
