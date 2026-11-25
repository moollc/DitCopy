"use strict";
// Run: node --test server/package.test.js
// The packaged copy is what people download, so its contents and its refusal of a bad Node are tested.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "package.js");
const all = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("packaging assembles a complete copy without the tests, and refuses a launcher stub for Node", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ditcopy-pack-"));
  try {
    const engine = path.join(work, "engine-file");
    fs.writeFileSync(engine, "engine");
    const bigNode = path.join(work, "node-big");
    fs.closeSync(fs.openSync(bigNode, "w"));
    fs.truncateSync(bigNode, 21 * 1024 * 1024); // sparse, looks like a real Node to the size check
    const out = path.join(work, "out");
    const ok = spawnSync(process.execPath, [SCRIPT, out, "--engine", engine, "--node", bigNode, "--version", "9.9.9"], { encoding: "utf8" });
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    const names = all(out).map((f) => path.relative(out, f).split(path.sep).join("/"));
    for (const must of ["ditcopy.js", "start.command", "start.sh", "start.bat", "stop.bat", "LICENSE", "README-FIRST.txt", "bundle.json", "server/server.js", "server/platform.js", "ui/index.html", "ui/app.js", "presets/camera-dual.json", "icon.ico", "icon.png"]) {
      assert.ok(names.includes(must), `missing ${must}`);
    }
    assert.ok(names.some((n) => /^engine\/ditcopy_engine(\.exe)?$/.test(n)), "engine in engine/");
    assert.ok(names.some((n) => /^runtime\/node(\.exe)?$/.test(n)), "node in runtime/");
    assert.deepStrictEqual(names.filter((n) => n.endsWith(".test.js")), [], "no tests in the download");
    const info = JSON.parse(fs.readFileSync(path.join(out, "bundle.json"), "utf8"));
    assert.strictEqual(info.version, "9.9.9");
    assert.strictEqual(info.platform, process.platform);

    const stub = path.join(work, "node-stub");
    fs.writeFileSync(stub, "#!/bin/sh\n");
    const bad = spawnSync(process.execPath, [SCRIPT, path.join(work, "out2"), "--engine", engine, "--node", stub], { encoding: "utf8" });
    assert.notStrictEqual(bad.status, 0);
    assert.match(bad.stderr, /not self contained/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
