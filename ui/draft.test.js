"use strict";
// Run: node --test ui/draft.test.js
const test = require("node:test");
const assert = require("node:assert");
const D = require("./draft");

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

test("the form is remembered and comes back as a preset", () => {
  const s = memory();
  assert.ok(D.write(s, { src: ["/a"], dest: ["/d"], mode: "force", hash: "xxh3", jobName: "card1", skipSystemFiles: false, confirm: true, volumeBindings: [{}] }));
  const p = D.read(s);
  assert.deepStrictEqual(p.src, ["/a"]);
  assert.strictEqual(p.name, "card1");
  assert.strictEqual(p.skipSystemFiles, false);
  assert.ok(!("confirm" in p) && !("volumeBindings" in p), "the confirmation and the bindings are never kept");
});

test("a destructive mode is never restored", () => {
  const s = memory();
  D.write(s, { src: ["/a"], dest: ["/d"], mode: "delete" });
  assert.strictEqual(D.read(s).mode, "force");
});

test("nothing useful, broken or blocked storage gives null and never throws", () => {
  assert.strictEqual(D.read(memory()), null);
  const s = memory(); D.write(s, { src: [], dest: [""], mode: "force" });
  assert.strictEqual(D.read(s), null, "an empty form is not worth restoring");
  const broken = { getItem: () => "{not json", setItem: () => { throw new Error("full"); } };
  assert.strictEqual(D.read(broken), null);
  assert.strictEqual(D.write(broken, { src: ["/a"] }), false);
  assert.strictEqual(D.read({ getItem: () => { throw new Error("blocked"); } }), null);
});
