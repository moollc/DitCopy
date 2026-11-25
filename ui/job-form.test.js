"use strict";
// Run: node --test ui/job-form.test.js
const test = require("node:test");
const assert = require("node:assert");
const { jobToPreset, formIsEmpty } = require("./job-form");

const live = { status: "running", src: ["/a", "/b"], dest: ["/d"], jobName: "card", mode: "force", hash: "xxh3",
  verify: true, nonstop: true, writeMhl: true, minSize: null, confirm: true };

test("a running job becomes a form preset with every path and option", () => {
  const p = jobToPreset(live);
  assert.deepStrictEqual(p.src, ["/a", "/b"]);
  assert.deepStrictEqual(p.dest, ["/d"]);
  assert.strictEqual(p.name, "card");
  assert.strictEqual(p.hash, "xxh3");
  assert.strictEqual(p.verify, true);
  assert.strictEqual(p.minSize, null);
});
test("confirm is never restored", () => {
  assert.strictEqual("confirm" in jobToPreset(live), false);
});
test("finished, incomplete or path-less jobs do not fill the form", () => {
  assert.strictEqual(jobToPreset({ ...live, status: "done" }), null);
  assert.strictEqual(jobToPreset({ ...live, status: "incomplete" }), null);
  assert.strictEqual(jobToPreset({ ...live, src: null }), null);
  assert.strictEqual(jobToPreset({ ...live, dest: [] }), null);
  assert.strictEqual(jobToPreset(null), null);
});
test("the preset is a copy, not the job's own arrays", () => {
  const p = jobToPreset(live); p.src.push("/x");
  assert.strictEqual(live.src.length, 2);
});
test("only an empty form is filled", () => {
  assert.strictEqual(formIsEmpty("", "  \n"), true);
  assert.strictEqual(formIsEmpty("/a", ""), false);
  assert.strictEqual(formIsEmpty("", "/d"), false);
});
