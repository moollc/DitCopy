"use strict";
// Run: node --test server/package-guards.test.js
// A download that only works on the machine that built it is the worst kind of bug, so the checks that stop it are tested,
// and the release is tested for still running them. Added 25 Nov 2026 after a Mac app built here failed on another Mac.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { audit } = require("../scripts/audit-bundle");

const ROOT = path.join(__dirname, "..");

function fakeBundle(dir, { nodeBytes = 21 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(dir, "engine"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bundle.json"), "{}");
  fs.writeFileSync(path.join(dir, "ditcopy.js"), "console.log('ok')\n");
  const node = path.join(dir, "runtime", process.platform === "win32" ? "node.exe" : "node");
  fs.closeSync(fs.openSync(node, "w"));
  fs.truncateSync(node, nodeBytes);
  const engine = path.join(dir, "engine", process.platform === "win32" ? "ditcopy_engine.exe" : "ditcopy_engine");
  fs.writeFileSync(engine, "engine");
  for (const f of ["start.command", "stop.command", "start.sh", "stop.sh"]) fs.writeFileSync(path.join(dir, f), "#!/bin/sh\n");
  for (const f of [node, engine, ...["start.command", "stop.command", "start.sh", "stop.sh"].map((n) => path.join(dir, n))]) fs.chmodSync(f, 0o755);
}

test("the audit passes a clean copy and fails each way a copy can depend on the machine that built it", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ditcopy-audit-"));
  try {
    const good = path.join(work, "good");
    fakeBundle(good);
    assert.deepStrictEqual(audit(good, { plat: process.platform }), [], "a clean copy passes");

    const baked = path.join(work, "baked");
    fakeBundle(baked);
    fs.writeFileSync(path.join(baked, "ditcopy.js"), `const root = "${os.homedir()}/code/thing";\n`);
    assert.match(audit(baked, { plat: process.platform }).join("\n"), /build machine/);

    const stub = path.join(work, "stub");
    fakeBundle(stub, { nodeBytes: 50 * 1024 });
    assert.match(audit(stub, { plat: process.platform }).join("\n"), /launcher stub/);

    const noNode = path.join(work, "nonode");
    fakeBundle(noNode);
    fs.rmSync(path.join(noNode, "runtime"), { recursive: true });
    assert.match(audit(noNode, { plat: process.platform }).join("\n"), /runtime\/node is missing/);

    const notBundle = path.join(work, "plain");
    fs.mkdirSync(notBundle);
    assert.match(audit(notBundle).join("\n"), /not a packaged copy/);

    if (process.platform !== "win32") {
      const locked = path.join(work, "locked");
      fakeBundle(locked);
      fs.chmodSync(path.join(locked, "start.sh"), 0o644);
      assert.match(audit(locked, { plat: process.platform }).join("\n"), /start\.sh is not marked executable/);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("the release builds nothing without the audit and the clean environment smoke test, in that order, before the archive", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const at = (text) => yml.indexOf(text);
  assert.ok(at("scripts/audit-bundle.js") > 0, "release must audit the package");
  assert.ok(at("scripts/smoke.js") > 0, "release must smoke test the package");
  assert.ok(at("scripts/package.js") < at("scripts/audit-bundle.js"), "audit comes after packaging");
  assert.ok(at("scripts/audit-bundle.js") < at("scripts/smoke.js"), "audit comes before the smoke test");
  assert.ok(at("scripts/smoke.js") < at("Make the archive"), "nothing is archived before it passes");
  assert.ok(!/continue-on-error:\s*true/.test(yml), "a failing check must fail the release");
});

test("the smoke test runs in a scrubbed environment and the packager refuses a Node that needs the build machine", () => {
  const smoke = fs.readFileSync(path.join(ROOT, "scripts", "smoke.js"), "utf8");
  assert.match(smoke, /function cleanEnv/, "smoke must build a clean environment");
  assert.match(smoke, /env\.PATH = sys\.join/, "smoke must replace PATH with the system folders only");
  assert.doesNotMatch(smoke, /\.\.\.process\.env\s*,/, "smoke must not pass the developer environment through");
  const pack = fs.readFileSync(path.join(ROOT, "scripts", "package.js"), "utf8");
  assert.match(pack, /not self contained/, "the packager must refuse a stub Node");
});
