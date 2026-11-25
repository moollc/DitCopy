"use strict";
// Run: node --test ui/roles-paths.test.js
const test = require("node:test");
const assert = require("node:assert");
const R = require("./roles");

test("posix paths keep working", () => {
  assert.ok(R.under("/Volumes/Kane/EFJ", "/Volumes/Kane"));
  assert.ok(R.under("/Volumes/Kane", "/Volumes/Kane/"));
  assert.ok(!R.under("/Volumes/Kane2", "/Volumes/Kane"));
  assert.ok(R.under("/media/dit/CARD", "/"));
  assert.ok(!R.under("/x", ""));
  assert.strictEqual(R.parentOf("/Volumes/Kane/EFJ"), "/Volumes/Kane");
  assert.strictEqual(R.parentOf("/Volumes"), "/");
});

test("Windows paths use backslashes and ignore case", () => {
  assert.ok(R.under("D:\\EFJ\\VID", "D:\\"));
  assert.ok(R.under("d:\\efj", "D:\\"));
  assert.ok(R.under("D:/EFJ", "D:\\"));
  assert.ok(!R.under("E:\\EFJ", "D:\\"));
  assert.ok(!R.under("D:\\EFJ2", "D:\\EFJ"));
  assert.strictEqual(R.parentOf("D:\\EFJ\\VID"), "D:\\EFJ");
  assert.strictEqual(R.parentOf("D:\\EFJ"), "D:\\");
});
