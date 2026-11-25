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

test("a version given by hand makes a private draft, only a tag publishes straight away", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(yml, /workflow_dispatch:\s+inputs:\s+version:/, "the version is an input of the manual run");
  assert.match(yml, /gh release create "\$tag" files\/\* --repo "\$\{GITHUB_REPOSITORY\}" --draft/, "a manual run only makes a draft");
  const draftLine = yml.split("\n").find((l) => l.includes("--draft"));
  assert.ok(draftLine && !/--latest|--draft=false/.test(draftLine), "a manual run never publishes");
  assert.match(yml, /already exists/, "publishing a draft must not trigger a second release");
});

test("the README opens with the downloads, and only developers are told to install Node or Rust", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const download = readme.indexOf("## Download");
  const source = readme.indexOf("## Run from source");
  assert.ok(download > 0 && source > download, "Download comes first, source comes after");
  const beforeSource = readme.slice(0, source);
  assert.doesNotMatch(beforeSource, /rustup|Install Rust|Install Node/i, "nothing before the developer section asks a normal person to install Node or Rust");
  for (const tail of ["\\.dmg", "-setup\\.exe", "\\.deb"]) {
    assert.match(readme, new RegExp(`releases/download/v[\\d.]+/DitCopy-[\\d.]+-[a-z0-9-]+${tail}`), `a direct download link ending ${tail}`);
  }
  assert.match(readme, /releases\/latest/, "a link to the releases page");
});

test("Macs of both kinds are built and tested on their own hardware, and every release is checked as a stranger afterwards", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(yml, /os: macos-latest, label: macos-arm64/, "Apple Silicon Macs");
  assert.match(yml, /os: macos-15-intel, label: macos-x64/, "Intel Macs, on a real Intel runner");
  assert.doesNotMatch(yml, /DitCopy-\$\{VERSION\}-macos-arm64\.dmg/, "the disk image is named for its own Mac, not always arm64");
  assert.match(yml, /\$\{\{ matrix\.label \}\}\.dmg/, "the disk image name uses the matrix label");
  assert.match(yml, /Live check: PENDING/, "a new draft says its live check is still pending");
  const verify = fs.readFileSync(path.join(ROOT, ".github", "workflows", "verify-release.yml"), "utf8");
  assert.match(verify, /types: \[published\]/, "the stranger check runs when a release is published");
  assert.match(verify, /Live check: \(passed\|skipped\)/, "and requires a recorded live check");
});

test("every installer is built, installed for real and tested from where it installs", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(yml, /audit-bundle\.js --app dist\/app\/DitCopy\.app/, "the Mac app is audited");
  assert.match(yml, /make-dmg\.sh/, "a disk image is made");
  assert.match(yml, /dpkg -i/, "the Debian package is installed");
  assert.match(yml, /smoke\.js \/opt\/ditcopy/, "and tested from /opt, which the user cannot write");
  assert.match(yml, /\/VERYSILENT/, "the Windows installer is run for real");
  assert.match(yml, /smoke\.js C:\\ditcopy-installed/, "and tested from where it installed");
  assert.match(yml, /os: ubuntu-22\.04/, "Linux is built on an old enough system for older Linux to run it");
  assert.doesNotMatch(yml, /os: ubuntu-latest[^\n]*linux-x64/, "not on ubuntu-latest, whose glibc is too new for older Linux");
});

test("every way the developer version can fail to start tells a normal person where to download the app, and Mac keeps the window open", () => {
  const link = "https://github.com/moollc/DitCopy/releases/latest";
  for (const f of ["start.command", "stop.command", "start.sh", "stop.sh", "start.bat", "stop.bat", "ditcopy.js"]) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), "utf8").includes(link), `${f} must point at the downloads when it cannot run`);
  }
  for (const f of ["start.command", "stop.command"]) {
    assert.match(fs.readFileSync(path.join(ROOT, f), "utf8"), /Press Enter to close/, `${f} must keep its window open on failure so the message can be read`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "start.bat"), "utf8"), /pause/, "start.bat must pause on failure");
});

test("the Mac app finds its own packaged copy and carries no path to the machine that built it", () => {
  const swift = fs.readFileSync(path.join(ROOT, "app", "main.swift"), "utf8");
  assert.match(swift, /Resources\?\.appendingPathComponent\("ditcopy"\)|resourceURL\?\.appendingPathComponent\("ditcopy"\)/, "the app looks inside itself first");
  const build = fs.readFileSync(path.join(ROOT, "app", "build-app.sh"), "utf8");
  assert.match(build, /--bundle/, "the build can make a self contained app");
  assert.match(build, /ROOT_KEY=""/, "a self contained app has no DitCopyRoot key");
  // CI passes relative paths. They must be read before the script changes into its own folder, or they point nowhere.
  assert.ok(build.indexOf("--bundle)") < build.indexOf('cd "$(dirname "$0")"'), "options are read before changing folder");
});

test("the smoke test runs in a scrubbed environment and the packager refuses a Node that needs the build machine", () => {
  const smoke = fs.readFileSync(path.join(ROOT, "scripts", "smoke.js"), "utf8");
  assert.match(smoke, /function cleanEnv/, "smoke must build a clean environment");
  assert.match(smoke, /env\.PATH = sys\.join/, "smoke must replace PATH with the system folders only");
  assert.doesNotMatch(smoke, /\.\.\.process\.env\s*,/, "smoke must not pass the developer environment through");
  const pack = fs.readFileSync(path.join(ROOT, "scripts", "package.js"), "utf8");
  assert.match(pack, /not self contained/, "the packager must refuse a stub Node");
});
