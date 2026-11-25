"use strict";
// Run: node --test server/launcher.test.js
// Starts and stops a real server through the launcher on a spare port, the same on macOS, Linux and Windows.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const L = require("../ditcopy");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test("the port is validated and the default port keeps the plain file names", () => {
  assert.strictEqual(L.parsePort(undefined), 34826);
  assert.strictEqual(L.parsePort("40001"), 40001);
  assert.throws(() => L.parsePort("0"));
  assert.throws(() => L.parsePort("70000"));
  assert.throws(() => L.parsePort("abc"));
  assert.strictEqual(L.suffixFor(34826), "");
  assert.strictEqual(L.suffixFor(40001), "-40001");
  assert.ok(L.paths(40001).pid.endsWith("server-40001.pid"));
});

test("the engine program name and override", () => {
  assert.ok(L.enginePath({}, "win32").endsWith("ditcopy_engine.exe"));
  assert.ok(L.enginePath({}, "linux").endsWith("ditcopy_engine"));
  assert.strictEqual(L.enginePath({ DITCOPY_ENGINE: "/x/engine" }, "linux"), "/x/engine");
});

test("start, status and stop work end to end", async () => {
  const port = await freePort();
  // Any existing file stands in for the engine, so this test needs no Rust build.
  const env = { ...process.env, DITCOPY_PORT: String(port), DITCOPY_ENGINE: process.execPath, OPEN_BROWSER: "0" };
  const run = (cmd) => spawnSync(process.execPath, [path.join(ROOT, "ditcopy.js"), cmd], { env, encoding: "utf8", timeout: 60000 });
  try {
    const started = run("start");
    assert.strictEqual(started.status, 0, started.stdout + started.stderr);
    assert.match(started.stdout, new RegExp(`127.0.0.1:${port}`));
    assert.strictEqual(run("status").status, 0);
    const again = run("start");
    assert.strictEqual(again.status, 0, "starting twice is fine");
    const health = await new Promise((resolve) => require("node:http").get({ host: "127.0.0.1", port, path: "/api/health" }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(JSON.parse(b))); }));
    assert.strictEqual(health.ok, true);
    assert.ok(["darwin", "linux", "win32"].includes(health.platform.platform));
  } finally {
    run("stop");
  }
  assert.notStrictEqual(run("status").status, 0, "stopped");
  for (const f of [L.paths(port).pid, L.paths(port).log]) { try { fs.rmSync(f); } catch { /* absent */ } }
});
